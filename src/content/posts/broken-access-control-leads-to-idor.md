---
title: Cross Users mail changing(IDOR)
date: '2026-09-23'
category: infosec
description: ''
tags:
  - web
draft: false
updated: '2026-09-26'
---

# Following an Email Change Toward Account Takeover

The email-change endpoint returned more than a confirmation message. Its JSON response contained the verification link itself, including the token intended to confirm access to the new mailbox.

That discovery came during testing of a community portal I will call `example.com`. The same workflow also accepted a substituted account identifier. Together, those behaviors exposed a path toward account takeover, although the final password-reset and login stages remained unverified.

## Looking inside the profile editor

I started with the email field in the profile settings. When I requested a change, the browser sent a request to:

```text
/api/sn_communities/v1/community/email_verification
```

The body contained two fields: `user_id` and `new_email`.

The second field was expected: the application needed to know the requested destination address. The first deserved closer attention. It allowed the browser to specify which account the operation concerned, even though the request already carried an authenticated session.

A client-supplied identifier can be part of a legitimate API design. Its presence becomes a problem when the server accepts a different user's identifier without checking whether the requester has permission to act on that account.

## Keeping the session and changing the target

I used two controlled accounts to examine that relationship. Account A was the requester; account B was the target. I already had their identifiers, which made this a test of authorization rather than a demonstration of user-ID discovery.

I retained account A's session cookies and `X-Usertoken`, then changed the request body to reference account B. I also supplied a controlled destination email address. The relevant parts of the modified request looked like this:

```http
POST /api/sn_communities/v1/community/email_verification HTTP/1.1
Host: example.com
Content-Type: application/json;charset=utf-8
Cookie: <ACCOUNT_A_SESSION_COOKIES>
X-Usertoken: <ACCOUNT_A_USER_TOKEN>

{
  "user_id": "<ACCOUNT_B_USER_ID>",
  "new_email": "attacker@example.com"
}
```

The session identified the requester, while the body selected a different account. The server needed to validate the relationship between them before initiating any change.

Instead, it returned a successful response:

```http
HTTP/1.1 200 OK
Content-Type: application/json;charset=UTF-8

{
  "result": {
    "message": "Verification link sent",
    "link": "https://example.com/community?token=<EXAMPLE_TOKEN>"
  }
}
```

The substituted identifier was accepted into the email-change workflow. The response also exposed another weakness through the `link` field.

## The verification secret came back through the API

An email confirmation flow is supposed to establish access to a mailbox. Its token serves that purpose only when obtaining the token requires access through the intended verification channel.

Here, the application returned the complete confirmation URL directly to the requester. The confirmation email contained the same link, but opening the inbox was unnecessary to obtain its secret: the API had already supplied it.

This was separate from the account-ownership problem. Even an endpoint restricted to changing the requester's own account should not reveal a mailbox-verification token through its ordinary response. Doing so undermines the ownership check the email is meant to provide.

I followed the confirmation flow and checked the target account through its separate test session. The email field in its edit-profile form displayed the address supplied in the modified request.

## Where the takeover claim stopped

The result raised an obvious concern about password recovery. If an attacker can change another account's recovery email to a mailbox they control, a password reset may become the next step toward taking over that account.

I had not completed that step. I did not verify that this community profile field controlled the login identity or recovery destination, and I did not reset a password and establish a new session as the target.

There was also a detail in the interface that deserved care: the public profile card continued to show the earlier email address while the edit-profile form displayed the replacement. The test did not establish why those views differed. It would have been premature to assume that every account or identity record had changed together.

The demonstrated behavior was therefore a cross-account email-change workflow, disclosure of its confirmation token, and an updated email field in the target's settings. Full account takeover remained a potential consequence dependent on the recovery mechanism. No bypass of MFA or external identity-provider protections was established.

Knowing the target's identifier was another condition of the test. I did not establish a way to enumerate arbitrary users' IDs, and the finding should not be read as proof that such identifiers could be brute-forced.

## Fixing both parts of the flow

The application needs to bind an email change to an authorized account from initiation through confirmation. For ordinary profile changes, deriving the target account from the authenticated session avoids relying on a browser-supplied account selector. If an identifier is accepted, the server must explicitly check the requester's authority over that account.

The initiation endpoint should return an acknowledgement without the verification URL. The token should be delivered through the intended verification channel, tied to the exact account and new address, and limited to one email-change action. It should also expire and become unusable after redemption.

Recent authentication and a notification to the previous verified address provide additional protection around a sensitive identity change. The implementation also needs a clear rule for how profile email updates affect sign-in and password recovery.

This investigation began with two fields in a request and a link in a response. Following them showed how account ownership and mailbox ownership could both be weakened within one workflow. The next decisive check would be whether that changed address actually governs recovery—the point where an email-change flaw could become a completed account takeover.

*The target, email addresses, account identifiers, sessions, and tokens in this article have been replaced with example values.*
