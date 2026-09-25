---
title: Verification Bypass
date: '2026-09-25'
category: infosec
description: How i bypassed verification
tags:
  - Web
draft: false
---

# How I Found a Mobile Verification Bypass by Reusing a Telephone Update Request

*A walkthrough of phone and email update testing in  Business Login, followed by an investigation into a possible IDOR and 2FA bypass.*

The decisive change in this investigation was a JSON field: `"type": "work"` became `"type": "mobile"`.

The application's normal mobile-number change flow displayed a TAN verification screen. However, a request used to update the ordinary telephone number also accepted a mobile-number update. The changed number appeared in the API response and, after reloading, in the account profile. I then used the same profile-update endpoint to replace the email address without completing an email confirmation step.

That led me to investigate whether the mobile-change workflow could also affect another account or bypass SMS-based two-factor authentication. Those later tests produced useful leads, but I did not confirm a successful cross-account change or completed 2FA bypass.

Credentials, account identifiers, contact details, and tokens have been replaced with placeholders. HTTP examples have been shortened for clarity.

## Starting with the normal account workflow

I began in the **My data and security configuration** page at `account-login.test.com`. It contained separate controls for the email address, mobile number, telephone number, password, and two-factor authentication.

The distinction between the two phone fields mattered. The ordinary telephone field used a straightforward save operation. The mobile-number flow displayed a **TAN Verification** page after I submitted a replacement number. In this application, the TAN acted as the one-time verification code for that operation.

The account overview also stated that two-factor authentication had not yet been configured. These initial tests demonstrated a contact-verification problem in an existing authenticated session.

## Finding 1: Changing the mobile number through the telephone update path

### Understanding the request

In Burp Suite, the telephone update used this endpoint:

```http
PUT /api/1.0/users/current HTTP/1.1
Host: account-login.test.com
Authorization: Bearer <TEST_ACCOUNT_ACCESS_TOKEN>
Content-Type: application/json
```

Its body represented a phone number as an object inside a `phoneNumbers` array:

```json
{
  "phoneNumbers": [
    {
      "type": "work",
      "value": "<TEST_TELEPHONE_NUMBER>"
    }
  ]
}
```

The response contained both `work` and `mobile` entries. The same data structure therefore described two fields that the browser handled through different workflows.

### The change that exposed the gap

I edited the request in Repeater, changed the type from `work` to `mobile`, and supplied a different number:

```json
{
  "phoneNumbers": [
    {
      "type": "mobile",
      "value": "<NEW_TEST_MOBILE_NUMBER>"
    }
  ]
}
```

The body contained no TAN or verification-task token. The response showed the replacement number under the `mobile` entry. I then reloaded the account page, where the mobile field displayed that new value.

This gave me two observable checks: the API returned the changed data, and the application subsequently displayed it after a reload. The normal mobile form had presented a TAN challenge earlier, yet this route updated the same profile field without a successful TAN submission in between.

The central finding was an inconsistency between the verification required by the mobile-change flow and the fields accepted by the general profile-update endpoint.

## Finding 2: Reusing the endpoint to replace the email address

The next question was whether the endpoint accepted other contact fields as well. I replaced the phone-number body with an `emails` array:

```json
{
  "emails": [
    {
      "type": "work",
      "value": "replacement@example.com"
    }
  ]
}
```

The endpoint was still the same authenticated `PUT` to `/users/current`.

The server returned `200 OK` and included the replacement email address in its response. After refreshing the account page, I could see the new address. I had not completed an email confirmation between sending the edited request and checking the updated profile.

The demonstrated behavior is therefore a direct email-address replacement through the general profile API. Whether the new address also becomes verified for login, recovery, or another security-sensitive purpose is a separate question; I did not confirm those outcomes.

### A reproduction detail: fresh request context

The email investigation included unsuccessful attempts. I suspected that an expired token or request context might be involved. I returned to the browser, captured fresh traffic, and subsequently obtained a working update request.

This suggested a request-context issue during reproduction, although I did not isolate a particular cookie as the cause. The successful profile-update requests included a bearer token.

I also noted different behavior with an existing account and considered using a fresh account. I did not isolate the reason for that difference, so it remained a reproduction observation rather than a confirmed account-age condition.

## Following the mobile-change workflow toward a possible IDOR

After the direct profile updates, I examined the dedicated security-task flow used by the mobile-number form.

The workflow used this initialization request:

```http
POST /api/1.0/securityTask/.init HTTP/1.1
Host: account-login.test.com
Content-Type: application/json
```

```json
{
  "identifier": "<TEST_ACCOUNT_IDENTIFIER>",
  "type": "ChangeMobileNumber",
  "properties": [
    {
      "name": "mobileNumber",
      "stringValue": "<PROPOSED_MOBILE_NUMBER>"
    }
  ]
}
```

The successful initialization response included these fields:

```json
{
  "identifier": "<TEST_ACCOUNT_IDENTIFIER>",
  "type": "ChangeMobileNumber",
  "tan": null,
  "verificationRequired": null,
  "token": "<SECURITY_TASK_TOKEN>",
  "redirectLabel": null,
  "properties": [
    {
      "name": "mobileNumber",
      "stringValue": "<PROPOSED_MOBILE_NUMBER>"
    }
  ]
}
```

The client-supplied `identifier` became the focus of the follow-up. I investigated how the workflow behaved when account identifiers and task tokens were changed. My hypothesis was that a weak binding between the caller, target account, task token, and proposed number might allow an unauthorized change.

That is an IDOR hypothesis: an application may let a caller act on another account by changing an identifier without enforcing the necessary authorization. The presence of an editable identifier alone does not establish that flaw. Likewise, task creation and `verificationRequired: null` do not establish that verification has been completed or bypassed.

## What the TAN verification tests actually showed

The subsequent verification endpoint was:

```http
POST /api/1.0/securityTask/.verifyTan HTTP/1.1
```

A shortened version of the request body used during testing is:

```json
{
  "identifier": "<TEST_ACCOUNT_IDENTIFIER>",
  "type": "ChangeMobileNumber",
  "token": "<SECURITY_TASK_TOKEN>",
  "redirectLabel": "null",
  "tan": "1234"
}
```

Here, `"null"` is a string in the verification request; it differs from the JSON `null` in the initialization response. I did not establish whether that difference affected the result.

The responses included:

- **403 Forbidden**, with the detail `ChangeMobileNumber: TAN does not match`.
- **503 Service Unavailable**, with `Service not available!` and `Network Error` in the response body.

I had difficulty receiving a TAN on the numbers available for testing and suspected a possible country-related delivery limitation. I did not confirm that the service only supported German numbers; the form included examples with several country codes.

I could not complete these later tests with a valid TAN. I therefore did not confirm an unauthorized cross-account mobile change or demonstrate a login that defeated an enabled second factor. The proposed IDOR and 2FA chain required further validation.

The different errors are useful evidence for understanding the workflow. They do not, by themselves, prove that the remaining authorization checks would permit the proposed attack.

The demonstrated issue affects the integrity of account contact details and the consistency of the verification workflow. Its wider impact depends on how the application uses those details after the update.

If a changed number or email address is trusted for authentication or recovery without additional checks, the consequences could extend beyond profile integrity. That dependency is a reason to investigate further, not evidence that account takeover already occurred.

## Likely cause and how to address it

Based on the observable behavior, the most plausible explanation is that verification was enforced in a dedicated workflow while the general profile endpoint still accepted the same sensitive fields. This is an inference from requests and responses; I did not inspect the server implementation.

The relevant control belongs at the point where the backend commits the change. Every route capable of changing the mobile number or email address should enforce the applicable verification policy. A route used for ordinary telephone updates should not allow a client to select a more sensitive field and skip its required checks.

For the security-task flow, the backend should bind each task to the permitted actor, target account, operation, and proposed value, and verify that binding when the task completes. An initialization response should never be treated as proof that the final authorization and verification steps succeeded.

## What I learned from the investigation

The useful clue was in the application's data model. The API response exposed `work` and `mobile` entries in the same structure, and a small request change revealed that their different browser workflows did not provide equivalent protection at the update endpoint.

Reloading the profile strengthened the evidence: it connected a modified request to an observable stored change. Keeping the later IDOR and 2FA experiments separate also preserved the scope of the result. A confirmed verification gap remains meaningful even when a proposed extension needs more evidence.

The lesson I took from this case is to trace sensitive data through every path that can change it, then verify the resulting account state. That is where the difference between an interesting response and a reproducible finding becomes clear.
