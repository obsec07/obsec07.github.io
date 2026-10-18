---
title: Unauthenticated-LDAP-Injection
date: '2026-10-03'
category: infosec
description: How i found unauthenticated LDAP injection that could lead to mass user's PII exctraction
tags: []
draft: false
updated: '2026-10-04'
---

**TL;DR**,

 I found an LDAP wildcard injection in an account-recovery API that accepted requests without authentication. Different responses to the `identifier` field let me recover one email address, a character at a time. The tricky part was proving the responses were reliable: sending requests too quickly produced false positives. The fix needs both proper LDAP filter escaping and recovery responses that don't reveal account information.

# How I Found an LDAP Injection With a Single Asterisk

I found this while looking through the JavaScript behind an account-recovery flow. There were several API calls for starting recovery, checking its status, and dealing with verification codes. Most of them accepted a field called `identifier`.

I wanted to see how that field was handled. It was user-controlled input being used to look up an account, which made it a useful place to start.

Before getting into the details: the finding hasn't been publicly disclosed. I'm using `target.com` throughout, and I've changed the endpoint paths and example identifiers too. The examples preserve the behavior without exposing the service or the people whose data it held.

The check request was small:

```http
POST /api/recovery/check HTTP/1.1
Host: target.com
Content-Type: application/json

{"identifier":"missing-user@example.invalid"}
```

It worked without a cookie, bearer token, or CAPTCHA. A nonexistent identifier returned `404`.

That gave me a baseline. The endpoint being reachable before login made sense for account recovery, so I started changing the identifier to see what happened during the lookup.

The input that caught my attention was `*`.

```json
{"identifier":"*"}
```

This time I got a `503`, and the response took roughly three seconds. The ordinary nonmatching requests had generally been much quicker.

I wasn't ready to call that an injection. A slow error could come from plenty of places. What made it worth following was what happened when I put characters before the asterisk.

Some prefixes returned `404`. Others returned `403`. Broader patterns often returned `503`.

The really useful comparison was between inputs of the same length. Here's the shape of it, with replacement prefixes:

```text
rava*  -> 403
ravb*  -> 404
ravc*  -> 503
```

Only one letter had changed. If this were just a length check or a blanket rejection of special characters, I wouldn't expect those three different answers.

I repeated the requests, mixed up their order, and kept a control in the sequence. In one set of 45 requests across five rounds, each input kept returning the same response category.

At that point, I had a working interpretation:

| Response | What it appeared to mean in these tests |
|---|---|
| `404` | The lookup hadn't found a match. |
| `403` | Something matched, but the operation was refused. |
| `503` | The pattern was broad enough to trigger a backend failure. |

The last row needed some care. I couldn't see the backend, so I couldn't say whether it had hit a result limit, a timeout, or something else. But narrowing the input changed the outcome in a repeatable way. That was enough to keep going.

LDAP looked like a good explanation. An LDAP filter such as `(uid=sample.user)` checks for an exact value, while `(uid=sample*)` performs substring matching. `(uid=*)` checks for the presence of the attribute. Those rules are described in [RFC 4515](https://www.rfc-editor.org/rfc/rfc4515.html#section-3).

A vulnerable application might build a filter along these lines:

```text
filter = "(uid=" + identifier + ")"
```

That's an example, not the application's source code. The important part is what happens if user input reaches the filter with its special meaning intact: an account identifier becomes a search pattern.

I tried other characters to compare their behavior. `?` didn't act like the asterisk. Neither did `%`, the regular-expression constructs, or the search-style operators I tested. Asterisks at the beginning, middle, and end of values behaved consistently with substring matching.

I also tried the usual parenthesis-based attempts to change the filter structure. Those didn't work. The useful behavior stayed with `*`.

Taken together, the results supported wildcard injection into an LDAP-style lookup. Confirming the exact filter and escaping code would still require the application's owners to look at the implementation.

The next question was how much information those responses could give away.

If a prefix matched, I could append a candidate character before the wildcard and check again. Using a made-up sequence:

```text
riv*    -> match
riva*   -> no match
rivb*   -> no match
rive*   -> match
```

That last response gave me a prefix worth following: `rive`. I could then repeat the process for the next character. There could be several matching branches, so the job was to follow and verify a branch rather than assume every position had exactly one answer.

This is what people mean by a blind oracle. The response doesn't contain the value you're looking for, but it tells you whether a question about that value was true.

My first walk started with a guessed prefix. I want to be clear about that because guessing a few characters and extending them is a weaker demonstration than finding something from scratch. I later repeated the process from an empty prefix, using the responses to guide the search.

Along the way, I made the obvious attempt to speed things up. That caused the most annoying part of the investigation.

When I sent requests concurrently, the endpoint started returning `403` for candidates that came back as `404` when checked on their own. Some sustained probing caused similar trouble. An automated run assembled a plausible-looking result out of those responses, but the result failed verification.

I had a string that looked like an account and no reliable evidence that it was one.

I threw that result away, slowed down, and checked candidates sequentially, roughly a second apart. I also rechecked them after the endpoint had been quiet. The useful distinctions came back.

I never established why faster probing changed the behavior. What I did establish was that it made the output unreliable. That's a fairly important difference when your script is choosing the next character based on an HTTP status.

It also exposed a weakness in the simple extraction logic: treating anything other than `404` as a hit. An unexpected server error or failed request can then turn into a character in your output. A candidate needs a repeatable response, a working negative control, and a final check once you've assembled the value.

After correcting for that, I recovered one complete email address. I checked the exact address without a wildcard and got the matching response. Changing one character gave a nonmatching response. I also checked possible extensions using the candidate character set.

That was the result I kept. The actual address and domain belong in the private report, so neither appears here. I stopped after that complete record; a second person's address wouldn't have made the underlying issue any clearer.

There was another assumption I had to drop. An escaped-looking input such as `\2a` returning `404` doesn't, by itself, prove that a server understands LDAP escaping. It might just be looking for that literal string and finding nothing. The stronger evidence was the pattern of comparisons and the verified recovery.

The impact was now concrete: someone without a session could infer a stored identifier from the endpoint's responses. For the recovered record, the exact-value request also revealed an account-existence difference. Earlier tests hadn't shown that distinction for every candidate, so I wouldn't assume it worked identically for every account or recovery state.

Even that narrower result matters. Knowing that a particular email address is associated with a service can help someone build a more convincing phishing attempt or choose accounts for credential attacks. I didn't carry out either of those follow-on attacks.

The slower responses to broad patterns raised an availability concern too. I recorded the delay and backend errors, but didn't demonstrate an outage. A request taking three seconds doesn't tell me that the server spent three seconds scanning a directory or consuming CPU.

There were limits elsewhere as well. I didn't demonstrate password disclosure, phone-number disclosure, arbitrary attribute access, or account takeover. Recovering an email-shaped value didn't reveal whether it lived in a separate mail attribute or was itself the account identifier. Those details needed a server-side review.

Similar wildcard behavior appeared in related recovery operations. That suggested the owners should look for shared lookup code instead of patching only the first route where I found it.

**For remediation, I'd start there and work outward:**

- **Fix the filter construction.** Use a maintained LDAP filter builder or a parameterized API that safely handles assertion values. Where string filters are necessary, use the library's search-filter encoder. LDAP distinguished-name escaping is a different operation; the two aren't interchangeable. [OWASP's LDAP injection prevention guide](https://cheatsheetseries.owasp.org/cheatsheets/LDAP_Injection_Prevention_Cheat_Sheet.html) covers this distinction.
- **Make sure the asterisk is covered.** Literal `*`, `(`, `)`, backslash, and NUL need the filter escapes `\2a`, `\28`, `\29`, `\5c`, and `\00`. The encoder also needs to handle the UTF-8 rules correctly. I'd use a tested library for this. [RFC 4515, section 3](https://www.rfc-editor.org/rfc/rfc4515.html#section-3) specifies the encoding.
- **Review what recovery responses reveal.** Account existence shouldn't change the public response in a way that lets someone distinguish users. Compare status codes, bodies, lengths, and timing. Keep detailed diagnostics in protected logs.
- **Put limits around the lookup.** Bound query time, result size, and concurrency. Apply recovery abuse controls across related endpoints, considering both request sources and targeted accounts. Keep sensitive transitions tied to a valid recovery task.
- **Check every caller of the shared code.** Validate the supported identifier formats and restrict the directory account's permissions. Then verify the fix with controlled matching and nonmatching accounts, literal special characters, and normal recovery flows.

I'd also repeat the original comparisons after the fix. A rejected wildcard is useful evidence, but the exact-value account-existence signal needs checking separately. Both problems showed up through the same endpoint, and fixing query construction doesn't automatically make its responses private.

What stayed with me was the failed fast run. It looked productive: more requests, more output, a value that resembled an account. Slowing down was what let me tell which parts were real. The complete address only became convincing once it survived those much less exciting checks.
