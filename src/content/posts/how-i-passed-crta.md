---
title: How I Passed CRTA..!
date: '2026-10-09'
category: infosec
description: 'My real CRTA exam experience: the reconnaissance, web vulnerabilities, Linux escalation, credential discoveries, and Active Directory attack path I followed, with exam-sensitive details sanitized.'
tags:
  - CRTA
  - Active Directory
  - Red Teaming
  - Penetration Testing
draft: false
---

---
**TL;DR**,

How I Passed CRTA: From a Web Application to Active Directory Compromise
My experience with the CRTA practical exam, the attack chain I followed, and the lessons I took away from it.
I recently passed the Certified Red Team Analyst (CRTA) practical exam. After finishing, I wrote down the commands I used, the problems I ran into, and how each discovery led to the next. I wanted to turn those notes into something more useful than a list of flags: an honest account of how I approached the environment and why the attack path worked.
What stood out to me was how the compromise developed. I did not begin with Domain Admin access or a known Active Directory exploit. I began by figuring out what was reachable, investigating two web services, and following evidence from one system to another. The final result was a path from a web-facing application to a highly privileged position in Active Directory.
> **About the details:** This is based on the exam I actually completed, not an invented success story. To avoid exposing exam-sensitive material, I have replaced IP addresses, domain and host names, account names, passwords, tokens, hashes, exact application routes, selected port numbers, and document contents with clearly illustrative examples. The technical findings and their order reflect my experience. There are no real flags or exam answers here. All example IP addresses use documentation-only ranges, and the commands are illustrative rather than copy-paste instructions for the original environment.
Starting with the environment
I worked from Kali Linux running in WSL2. My VPN connection was established inside Kali, so before scanning anything, I confirmed the tunnel and reviewed the routes pushed by the VPN server.
I kept the VPN authentication file restricted to my account and started OpenVPN from inside Kali. Below is the same operational pattern using made-up filenames only; it contains none of my exam VPN details.
```bash
chmod 600 ~/lab/vpn.auth
sudo openvpn --config ~/lab/vpn.ovpn \
  --auth-user-pass ~/lab/vpn.auth \
  --log ~/lab/openvpn.log --daemon

ip -br addr
ip route
```
The tunnel came up successfully, and the pushed routes showed that an additional internal subnet was already reachable. I did not need an additional tunneling step merely to reach it.
The routing information was important. It showed the network I was initially supposed to investigate and another internal range accessible through the same tunnel. I kept both in mind instead of assuming the first subnet was the whole environment.
For the sanitized examples in this article, I will refer to the first network as `192.0.2.0/24` and the additional internal network as `198.51.100.0/24`. These are reserved documentation ranges, not the actual exam networks.
I also ran into a WSL2 networking detail worth mentioning: when OpenVPN is connected inside WSL, Windows applications do not necessarily inherit the same VPN route. Rather than spending time forcing the browser on the host OS to use the tunnel, I kept my enumeration and HTTP requests inside Kali.
The first lesson was simple: check connectivity and routing before treating an unreachable host as a dead host.
Reconnaissance: finding the first useful service
I started with a targeted discovery scan over the allowed range, excluding the address that was outside scope. One system stood out because SSH was reachable. I followed that with a full TCP port scan on the discovered host.
Here is the equivalent workflow using replacement addresses:
```bash
# Documentation-only addresses; not the original targets.
sudo nmap -Pn -n --open --exclude 192.0.2.1 \
  -p 22,80,443,445,3389,8080,8000,8888 192.0.2.0/24

sudo nmap -Pn -n -p- 192.0.2.11
```
The broader scan revealed more than SSH. The machine had a monitoring-style web application and a separate Python web service listening on a nonstandard port. The first looked like a JavaScript single-page application built with Express and Vite; the second exposed Python/Werkzeug-style response headers consistent with Flask. Recognizing the two different technology stacks helped me decide what to investigate next. My next step was not to brute-force either one. I visited their landing pages and examined their responses.
```bash
curl -i http://192.0.2.11:8088/
curl -i http://192.0.2.11:23080/
```
One of the services exposed a useful clue in an error response: it expected a request to a file-handling endpoint and accepted a user-controlled URL parameter. It even suggested a `file://` path format. I treated that as a lead and checked what the handler could read rather than assuming that an informative error was itself proof of a vulnerability.
The other web service presented itself as a host-monitoring dashboard. At this point, I noted both applications as potential sources of configuration and operational information.
A file-read vulnerability that crossed the container boundary
The Python application accepted a URL-like parameter and attempted to open a local file when it began with `file://`. I tested the behavior carefully and found that the endpoint could return filesystem content.
A sanitized equivalent of the request is:
```bash
curl 'http://192.0.2.11:23080/inspect?url=file:///mnt/host/etc/passwd'
```
The important part is not the route name or port; both have been changed here. The important part is that an unauthenticated request supplied a filesystem path and the application read it without enforcing a safe boundary.
The service was containerized, but a host filesystem path was mounted into the container. That made the impact significantly worse: the read primitive was not restricted to ordinary application files inside the container.
Later, after I obtained privileged access and reviewed the application source, the root cause made sense. This simplified code shows the same class of mistake:
```python
# Simplified example, not the original source code.
@app.get('/inspect')
def inspect_file():
    url = request.args.get('url', '')
    if url.startswith('file://'):
        path = url[len('file://'):]
        with open(path, encoding='utf-8') as handle:
            return handle.read()
```
There was no meaningful validation of the filesystem path. If the process could read a file, the web route could expose it. Reviewing the application code later also showed a separate branch that made HTTP requests to supplied URLs. That is an SSRF-capable pattern in the absence of destination restrictions, although my recorded initial-access proof used arbitrary file read, not an independently demonstrated SSRF impact.
While checking a system account file, I encountered something unusual: an account's comment/GECOS field contained a password-like value. Passwords do not belong in that field. In this case, the exposure provided a credential that could be tested against the host.
For illustration, this is a fake account entry:
```text
webops:x:1000:1000:EXAMPLE-ONLY-NOT-A-REAL-PASSWORD:/home/webops:/bin/bash
```
This stage taught me two things: containerization is not a substitute for safe filesystem access, and a file-read vulnerability can have a much greater impact when administrators put secrets in unexpected places.
From a foothold to root on Linux
With the exposed host credential, I was able to establish a low-privileged SSH session. I checked the identity, hostname, and sudo permissions before moving further.
```bash
ssh webops@192.0.2.11
id
hostname
sudo -l
```
The most important result was that the account could run `vi` with elevated privileges. That caught my attention immediately because `vi` is not just a text editor: it can invoke a shell or external commands. A sudo rule allowing a general-purpose editor to run as root can be equivalent to giving the user a root execution path.
I used that misconfiguration to escalate privileges in the exam environment. My original notes recorded an editor shell escape and a temporary change to the SUID permission on Bash, followed by a privileged Bash session. I am not reproducing the exact exam command here, but the important mechanism is that an editor allowed through `sudo` can execute other programs with the editor's elevated privileges. GTFOBins documents why these broad sudo rules are risky.
I also noticed that the account belonged to the `lxd` group, a potential second escalation route in certain configurations. I did not need to exploit or validate that route because the `vi` path already worked.
The broader finding was overly permissive sudo configuration. The application credential gave me a foothold; the privileged editor turned that foothold into host-level control. Importantly, modifying the SUID bit creates a potentially dangerous leftover. My original notes included a cleanup command for that change, but do not establish that it was actually executed during the exam. A responsible authorized test should verify that such modifications are removed, for example:
```bash
# Cleanup illustration: execute with appropriate administrative rights.
sudo chmod u-s /bin/bash
stat -c '%A %n' /bin/bash
```
Looking beyond the initial shell
Once I had access to the host, I spent time understanding what was running rather than immediately jumping to the next IP address. That decision paid off.
The host had two relevant containers, including the monitoring web application and the Python service I had already investigated. I reviewed running containers, application configuration, source files, shell history, and authentication logs. The host-side application directories later allowed me to cross-check the observed HTTP behavior against the actual route-handling logic.
```bash
docker ps
docker inspect monitor-web \
  --format '{{range .Config.Env}}{{println .}}{{end}}'

# Example commands for examining the web applications' source.
find /opt/demo-apps -type f \( -name '*.py' -o -name '*.js' \) 2>/dev/null
```
The path in the last command is invented for illustration; it is not an exam path.
The container metadata contained a web administrator credential. I also found a less obvious clue inside a web application route and a separate database-related value embedded in a publicly served static asset.
These are fabricated examples of the kinds of values I encountered:
```text
MONITOR_ADMIN_USER=demo-admin
MONITOR_ADMIN_PASSWORD=DemoOnly!ChangeMe2026
```
```css
:root {
  --demo-db-password: "Example_Not_A_Secret_2026";
}
```
Finding a secret in a CSS file may seem strange, but that was part of the lesson: developers and administrators sometimes place sensitive values in files that are accessible to anyone who can load a page. A secret does not become safe just because it is embedded in source code or encoded in Base64.
The application code also included a less obvious route that returned a JSON message with a token-like field and a hint pointing toward the other web service. I used it to connect my earlier observations, not as a replacement for validating the actual issue. In this made-up example, the same relationship could look like:
```bash
curl -s http://192.0.2.11:8088/hint
# {"message":"Review the separate file service","secretToken":"DEMO-TOKEN-ONLY"}
```
This is a replacement endpoint and replacement token, not the original exam route or answer.
The CSS finding also had an extra step in my notes: I Base64-encoded the discovered database-style value as part of evidence collection. Base64 is only an encoding, not encryption. Here is the process with the synthetic CSS value shown above:
```bash
printf '%s' 'Example_Not_A_Secret_2026' | base64
```
Logs gave me the next direction
One of the most valuable discoveries on the compromised host came from its logs and command history. Command history contained earlier `ping` attempts against multiple addresses, including a host in the additional network, and a command showing that someone had inspected Docker containers. Authentication logs contained repeated references to the same internal address. Because the VPN had already supplied a route to that network, the finding was immediately actionable within the exam scope.
In the sanitized example, that address is `198.51.100.20`.
```bash
# Example of reviewing source addresses in authentication logs.
sudo zgrep -hoE 'from [0-9.]+' /var/log/auth.log* | \
  sort | uniq -c | sort -rn
```
A repeated address by itself does not mean a host is vulnerable. It tells you that there may be a relationship worth investigating. I treated it as a lead and checked the services on that second system.
This was one of my favorite parts of the process because it felt more like following evidence than running tools blindly.
The internal web server and an exposed service credential
The second host exposed an Apache-backed web service. During content discovery, I found an elFinder-style file-management interface, with directory listing enabled on a web-served files directory. A plain-text resource file within that area contained credentials for an Active Directory synchronization service account. I also checked the Apache service banner as part of fingerprinting; its precise version number is intentionally omitted because it appeared among my exam answers.
I have changed the filename, location, username, domain, and password here. The following is not the original URL or data:
```text
http://198.51.100.20/shared/example-sync-notes.txt
```
```text
# Example content — entirely synthetic
Service: Directory Synchronization
Username: svc_directory_sync@atlas.lab.example
Password: DemoSync!2026-NotReal
```
That discovery mattered because it connected the Linux and web portions of the engagement to Active Directory. A web server's directory listing had exposed credentials for a service that operated in a more privileged trust boundary.
At this point, I had to verify two separate things: whether the account could authenticate and what permissions it actually had. Finding a username and password is not enough to conclude that domain compromise is possible.
Identifying the Domain Controller
I enumerated Active Directory-related ports in the additional network and identified a Windows server exposing the services commonly associated with a Domain Controller, including Kerberos, LDAP, and SMB.
```bash
sudo nmap -Pn -n --open \
  -p 88,135,389,445,5985 198.51.100.0/24

netexec smb 198.51.100.100
```
For the examples in this article, the Domain Controller is `198.51.100.100` in the replacement domain `atlas.lab.example`. I used SMB enumeration and account validation to confirm that I was interacting with the domain environment. In the original workflow, I also used `kerbrute` to check which supplied candidate account names were valid in the Kerberos realm. Here is an illustrative command with a fake realm and fake input file:
```bash
kerbrute userenum --dc 198.51.100.100 \
  -d atlas.lab.example demo-candidates.txt
```
A valid username is not the same thing as a valid password, and neither alone establishes privileged access. The next stage was the most critical one: understanding the permissions assigned to the synchronization account.
The Active Directory turning point: DCSync
The exposed service credential was associated with a synchronization role resembling an Azure AD Connect password-sync service account. In the environment I assessed, the account had replication-related permissions that made a DCSync attack possible. The account's permissions—not the fact that its name contained `sync`—were the deciding factor.
DCSync does not require interactive login to a Domain Controller. Instead, it abuses Active Directory replication capabilities to request sensitive directory information. If an account has sufficiently broad replication rights, that can include password hashes for privileged identities.
It is important not to assume that every account called `sync` has those rights. The effective delegated permissions are what matter. In particular, Replicating Directory Changes and Replicating Directory Changes All are central to the risk of replicating secret material.
In the authorized exam environment, I validated the account and used Impacket to demonstrate the impact of those rights. Below is only a representative command shape with replacement account details; no real secret or hash is provided.
```bash
netexec smb 198.51.100.100 \
  -u svc_directory_sync -p 'DemoSync!2026-NotReal'

impacket-secretsdump \
  'atlas.lab.example/svc_directory_sync:DemoSync!2026-NotReal@198.51.100.100' \
  -just-dc-ntlm
```
The result confirmed that the permission exposure reached well beyond the service account itself. I was able to recover privileged account hash material in the lab. I am deliberately not including the actual hashes or the original output.
This was the moment the full attack path came together: an external-facing file-read issue led to a host credential, the host led to another internal service, and that service exposed an account with rights capable of compromising the domain.
Validating the final objective
After confirming the privileged directory access, I used Pass-the-Hash with the recovered Administrator NTLM hash to authenticate to the Domain Controller's SMB service. I then enumerated the administrative share, located the target XML-related document, and retrieved it using NetExec. I checked the full filename carefully rather than relying on the expected extension, which mattered during the final retrieval.
The command shape below uses a placeholder hash and an entirely invented file location. It is included to explain my workflow, not to reveal the original path or challenge answer:
```bash
DEMO_ADMIN_NT_HASH='REPLACE_WITH_AUTHORIZED_LAB_HASH'

netexec smb 198.51.100.100 -u Administrator \
  -H "$DEMO_ADMIN_NT_HASH"

netexec smb 198.51.100.100 -u Administrator \
  -H "$DEMO_ADMIN_NT_HASH" --share C$ --dir 'DemoEvidence'

netexec smb 198.51.100.100 -u Administrator \
  -H "$DEMO_ADMIN_NT_HASH" --share C$ \
  --get-file 'DemoEvidence\sample-records.xml.txt' ./sample-records.xml.txt
```
I am not publishing the original path, filename, XML fields, or contents because those are exam-specific details. A harmless stand-in would look like this:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<AssessmentEvidence>
  <Environment>Sanitized CRTA write-up example</Environment>
  <Data>Intentionally replaced</Data>
  <Objective>Access validated in authorized lab</Objective>
</AssessmentEvidence>
```
By the end, I had recovered all 17 flags recorded in my exam notes and completed the final objective. The important part for this article is not a list of flags or their answers, but the chain of decisions that got me from reconnaissance to the final objective.
The full attack chain, in one view
```text
Initial in-scope network
  |
  v
Web-facing Linux host
  |-- Service enumeration revealed two web applications
  |-- Unsafe file-handling route exposed local/host files
  |-- Account record exposed a usable credential
  |-- SSH foothold + sudo vi shell escape -> root
  |-- Alternative lxd group membership noted, not exploited
  |-- Container environment, hidden route and CSS asset gave clues
  |-- Shell history and logs pointed to another internal host
  v
Second internal web server
  |-- Directory listing exposed an internal resource file
  |-- Resource file contained a directory-sync account credential
  v
Active Directory
  |-- Domain Controller identified through AD services
  |-- Sync account authentication and replication rights validated
  |-- DCSync exposed privileged account hash material
  |-- Pass-the-Hash and SMB share access retrieved final evidence
  v
CRTA objective completed · all 17 flags recovered
```
Every arrow mattered. Without the file-read issue, I might not have obtained the first credential. Without checking sudo permissions, I might not have had enough access to inspect the host. Without reading logs and reviewing exposed web content, I might have missed the service credential that bridged the environment into Active Directory.
What I learned from passing CRTA
The biggest takeaway was that enumeration is not a phase you finish once. I had to enumerate at the start, after the first foothold, after gaining root, when moving into the second network, and again when I reached Active Directory. Each new level of access changed what I could see.
I also learned to pay attention to the smallest pieces of evidence: an informative error message, a strange field in an account record, a sudo rule, an environment variable, a static file, or a repeated source IP in a log. None of them looked like a full domain compromise on its own. Together, they provided the path.
From a defensive perspective, the issues were just as connected. The web endpoint needed proper path validation and isolation from host files. Secrets should never have been embedded in account metadata, container configuration accessible to unnecessary users, or public static assets. Sudo should have been limited to narrowly defined administrative actions. Internal files containing service credentials should not have been web-accessible. And Active Directory replication permissions should have been restricted to the accounts that genuinely required them, with strong credential protections and monitoring.
Most importantly, the exam reinforced why I enjoy red teaming: the interesting part is not simply running an exploit or finding a credential. It is understanding the environment well enough to connect one finding to the next, proving the impact, and being able to explain the root causes afterward.
Final thoughts
Passing CRTA was a meaningful milestone for me because I had to work through a connected environment rather than solve one isolated vulnerability. My final notes contained commands, discoveries, mistakes, and a lot of trial and error. Writing them up helped me see the attack path more clearly.
I have intentionally kept the real exam infrastructure and answers out of this post. But the technical lessons are real, and they are the part I wanted to share: small security weaknesses can become a serious Active Directory compromise when they connect across systems and trust boundaries.
Thanks for reading. This post reflects my personal learning experience in an authorized exam environment; all identifying values and examples have been sanitized.