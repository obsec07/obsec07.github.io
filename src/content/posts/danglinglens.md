---
title: DanglingLens - Evidence-first subdomain takeover scanner
date: '2026-10-31'
category: tools
description: 'Finds subdomains whose CNAME points to a deleted cloud resource, checked with two DNS resolvers in two rounds and exact provider responses, so a lead is backed by evidence instead of a guess.'
tags:
  - tool
  - subdomain-takeover
  - dns
  - recon
draft: false
---

**Subdomain takeover triage that shows its evidence, not just a list of guesses.**

Check it out on GitHub: [github.com/obsec07/danglinglens](https://github.com/obsec07/danglinglens)

A subdomain takeover starts with a DNS record that outlived the thing it pointed to: a deleted S3 bucket, a removed Heroku app, a GitHub Pages site nobody owns anymore. Most scanners match a stale error string and call it a takeover. DanglingLens is stricter: a host is only a lead when the DNS and the provider's response line up and **reproduce**.

## How it decides

- **DNS:** the full CNAME chain is traced on two independent resolvers (1.1.1.1 and 8.8.8.8 by default), in two separate rounds. Disagreement or errors are reported as "incomplete", never as a finding.
- **Provider checks:** recognized targets get exact checks. For example, Amazon S3 must answer `NoSuchBucket` for the host's exact bucket name with S3's own server identity; GitHub Pages, Heroku, Netlify and Azure need their own missing-site response and server header.
- **Wildcard control:** random sibling names are looked up too, so wildcard DNS doesn't produce fake leads.
- **Ownership records:** Azure `asuid` TXT records are checked, because they can block a claim.
- **Coverage:** Amazon S3, GitHub Pages, Azure App Service and Blob Storage, Heroku and Netlify, plus any CNAME that points to a name that no longer exists.

## Install and run

```bash
git clone https://github.com/obsec07/danglinglens.git && cd danglinglens
python3 -m venv .venv && source .venv/bin/activate
python -m pip install .

danglinglens scan -d example.com
danglinglens scan subdomains.txt --jsonl results.jsonl
subfinder -d example.com -silent | danglinglens scan -
```

Results go to the terminal as one short line per lead. `--jsonl` saves every result, and `--evidence-dir` keeps the raw DNS answers and HTTP responses for your report.

## Proving it safely

DanglingLens never creates cloud resources, buys domains or changes DNS. After you have legitimately claimed a resource on an in-scope target, `danglinglens challenge` gives you a harmless marker file to serve, and `danglinglens verify --verify-tls` checks that it is served on the original host over verified HTTPS. That is your proof of control. Use it only on targets you are authorized to test.

[Check it out on GitHub!](https://github.com/obsec07/danglinglens)
