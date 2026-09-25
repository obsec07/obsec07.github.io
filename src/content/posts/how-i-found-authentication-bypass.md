---
title: How i found Authentication Bypass
date: '2026-09-25'
category: infosec
description: Authentication Bypass
tags:
  - web
draft: false
---

# How a Failed Login Opened an Admin Panel

I submitted a login request that the application rejected. The server returned `401 Unauthorized`, along with an explicit invalid-credentials error. After I changed that response in Burp Suite, the browser opened the administration interface anyway.

That was the beginning of this finding on a portal I will call `example.com`. To understand why the application behaved this way, I dug into its frontend JavaScript. The bundle contained a hardcoded service-account credential and an interceptor that attached it to requests independently of the user's login state.

## Starting with a rejected login

I began by examining the request behind the administration login form. The application sent an email address and password to a dedicated login endpoint. A shortened, anonymized version looked like this:

```http
POST /api/user/login HTTP/1.1
Host: example.com
Content-Type: application/json;charset=utf-8
Authorization: Basic <SERVICE_ACCOUNT_BASIC_VALUE>
Cookie: <EXISTING_BROWSER_COOKIES>

{
  "email": "researcher@example.com",
  "password": "invalid-example-password"
}
```

The credentials were rejected. The response made that clear:

```http
HTTP/1.1 401 Unauthorized
Content-Type: text/html; charset=utf-8

invalidCredentialsError
```

At this point, the login endpoint was behaving as expected. I wanted to understand how the frontend used that result, so I intercepted the response before the browser received it.

## Changing what the browser received

I changed the status from `401 Unauthorized` to `200 OK` and removed the error text. With the content length adjusted for the empty body, the relevant part of the response became:

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Content-Length: 0

```

After forwarding the edited response, I returned to the browser. The administration area opened, exposing the Announcements, Guides, Contacts, and FAQ sections and their management forms.

The authentication service had still rejected the login. I had changed only the response delivered to my browser. Nevertheless, the frontend proceeded into its administrative workflow.

This established a bypass of the frontend's login gate. The test retained the application's existing request headers and browser cookies, so it did not establish how a completely fresh, cookie-free session would behave.

## Finding the credential in the JavaScript bundle

The `Authorization` header in the login request became an important clue. I traced its construction to module `1E04` in the publicly accessible frontend bundle:

```text
/apps/assets/js/app.2f037578.js
```

The module contained a service-account username and password as hardcoded strings. It joined them with a colon, Base64-encoded the result, and registered a global Axios request interceptor. With readable variable names and example credentials substituted, the relevant code looked like this:

```javascript
var username = "example_service_user";
var password = "example-service-password";
var basicAuthHeader =
    "Basic " + Buffer.from(username + ":" + password).toString("base64");

axios.interceptors.request.use(function(config) {
    config.headers["Authorization"] = basicAuthHeader;
    return config;
});
```

There was no login-state check in that interceptor. Every request passing through this Axios client received the same `Authorization` header, including requests made before a successful per-user login.

Base64 encoding provided no secrecy. Anyone who could download the public bundle could read the credential and reconstruct the header. The browser already had everything it needed to present that shared service-account credential.

## Two authentication mechanisms that were disconnected

The login exchange now made more sense. The email and password in the request body belonged to the attempted user login. The Basic Auth value in the header came from the application's hardcoded service account. These were two different sets of credentials traveling in the same request.

The frontend used the result of `POST /api/user/login` to control access to its admin interface. The interceptor supplied the service credential regardless of that result. Rejecting the user's credentials therefore did not stop subsequent API requests from carrying the shared Basic Auth header.

Changing the intercepted response opened the UI gate. The JavaScript finding explained why the requests behind that interface continued to carry an application credential even after the real login had failed.

My analysis suggested that the backend relied on the shared credential for API access. Wherever an endpoint accepts that credential without independently validating the current user's identity and permissions, the effective access boundary becomes a password distributed in public JavaScript. A visitor can obtain that credential without passing the application's per-user login.

The bundle establishes the credential exposure and unconditional header attachment. Whether the shared credential is sufficient for a particular privileged operation still depends on that endpoint's server-side checks.

## Checking how far the bypass went

Opening an admin panel was a useful observation, but I still needed to understand what the backend would accept. I continued into the available forms and checked the requests they generated.

One test attempted to create a guide through:

```http
POST /api/guides/create HTTP/1.1
Host: example.com
```

The server returned `401 Unauthorized`. That operation was rejected, but the response alone did not identify whether the failure involved the service credential, permissions, or another backend check. It did not establish that the backend enforced the real user's login consistently across all endpoints.

An announcement submission produced a different visible result. The interface displayed a `Created` message and added a disabled test announcement to its list. That was worth investigating, but I had not independently confirmed the announcement's persistence through a separate request or session. The success message alone could not establish that an unauthorized write had been stored.

Together, the request checks and JavaScript analysis established a bypass of the frontend login gate, exposure of a shared service-account credential, and automatic use of that credential by the API client. The rejected guide request and unverified announcement persistence still limited any claim of unrestricted administrator access.

## What I took away from this test

The exposed service credential needs to be revoked or rotated and removed from publicly delivered code. Removing it from a new bundle alone would leave previously copied credentials usable. If the application needs a service account, its secret belongs on the server, with permissions limited to the operations that service actually needs.

Administrative APIs also need to authenticate the real user and enforce that user's permissions on every request. A shared application credential cannot establish which human is making a request or whether that person is an administrator. The frontend should obtain validated session information before presenting privileged views, while the backend independently checks every management operation.

Inspecting the JavaScript changed my understanding of the finding. Response tampering exposed the weakness in the UI gate; the hardcoded credential and unconditional interceptor explained the authentication material behind the subsequent API requests. The underlying design problem was distributing a service-account secret to the browser while treating a separate frontend login as the route into administrative functionality.

*The target, account details, and authentication values in this article have been anonymized. HTTP excerpts omit unrelated headers.*
