# Remote unlock: what it actually requires

This is an investigation, not an implementation. The conclusion is that the requirement as
written — unlock a locked PC remotely, *never* using the Windows password — cannot be met on
WOLF's primary target through any supported Windows mechanism. What follows is why, what the
alternatives cost, and what is worth building instead.

Nothing here should be re-derived later, which is the reason it is written down.

## What the contract already promises

`power.unlock` exists in the protocol: `critical` risk, `privileged` capability, and a payload
naming "the dedicated WOLF unlock credential provisioned on the PC", with the note that "the
credential never travels with the command and is never returned to the cloud".

No agent implements it, so the cloud refuses it as unsupported. That is currently the honest
state and it should stay that way until one of the routes below is actually taken.

## The fact everything else follows from

**Windows has no API that unlocks a session.** Winlogon unlocks a workstation by handing
credentials to LSA and being told they are valid for the user who owns the session. There is
no privileged call that says "this session is now unlocked" — not for SYSTEM, not for an
administrator, not from a service.

So every route below is really an answer to one question: *where do credentials LSA will
accept come from, if not from the person at the keyboard?*

Two related things that look like answers and are not:

- `LsaLogonUser` with `MSV1_0_S4U_LOGON` produces a token without a password, but an
  impersonation token is not an interactive session and cannot unlock one.
- An administrator at the lock screen can sign in as themselves. That does not unlock the
  locked session — it starts a second one, and Windows offers to sign the first one out.

## Route 1 — the operator types the password on the lock screen — **built**

The one that works, is small, and is what every commercial remote-desktop tool does. This is
the route WOLF took; see [typing on the lock
screen](remote-desktop.md#typing-on-the-lock-screen).

The secure host runs as SYSTEM on `winsta0\Winlogon`, so `SendInput` from it reaches that
desktop — the same mechanism the user host already uses, in a process that is already on the
right desktop. Authorisation stays in the user host, which is the one that holds the session
and the control lease; only the injection moves.

- **Cost:** small, and paid. Like the rest of the secure-desktop path, the relay in the
  middle has never run — both ends have.
- **What it gives:** the operator sees the lock screen and signs in as themselves.
- **What it costs the security model:** the password crosses the encrypted stream as
  keystrokes. WOLF never stores it, never logs it, and never sees it as a password — it is
  key events like any other. That is a materially different claim from "WOLF holds your
  Windows password", and it should be stated in exactly those terms rather than blurred.
- **What it does not give:** unlocking a PC whose password the operator does not know, and
  unattended unlock.

## Route 2 — a credential provider that supplies the password

A credential provider is a COM DLL registered under
`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers` and
loaded by **LogonUI.exe**. Writing one is well-trodden and, importantly, LogonUI is *not* a
protected process, so no special signing is required.

But a provider's job is to hand Winlogon a serialised credential — for the unlock scenario, a
`KERB_INTERACTIVE_UNLOCK_LOGON` packed with domain, user and **password**. A credential
provider on its own therefore does not avoid the password; it automates typing it.

That means WOLF would have to hold the Windows password on the PC, sealed at enrolment and
released when the cloud authorises an unlock. DPAPI to the machine, and only SYSTEM can read
it — but it is still WOLF storing a Windows password, which is the thing the requirement
exists to forbid. **This route is rejected on the requirement, not on feasibility.**

## Route 3 — a custom LSA authentication package

The route that would genuinely satisfy "never the Windows password": a DLL loaded into
`lsass.exe` that validates a WOLF-specific secret and returns a logon for the user, the same
way third-party MFA products do push-approved unlock.

**This is blocked, and the evidence is on the machine this was written on.**

```
HKLM\SYSTEM\CurrentControlSet\Control\Lsa\RunAsPPL = 2
Authentication Packages = msv1_0
```

`RunAsPPL = 2` is LSA running as a Protected Process Light, enforced — the default on Windows
11. Every DLL lsass loads must then be signed to the protected-process standard, which for a
third party means an attested signing submission to Microsoft under the LSA protection
programme, not an ordinary code-signing certificate.

- **Cost:** a signed, Microsoft-attested binary, plus the engineering. A bug in an
  authentication package is an authentication bypass on every machine that has it; a crash in
  one is a PC that will not reach a desktop.
- **Verdict:** not a slice. This is a product-level commitment with a compliance process
  attached, and it should be taken deliberately or not at all.

## Route 4 — a TPM virtual smart card

Windows supports TPM-backed virtual smart cards (`tpmvscmgr.exe`, present on this machine),
and a smart card is a credential LSA accepts that is *not* the Windows password. The private
key is TPM-bound and cannot be exported, so possession genuinely requires being on that PC —
which is a meaningfully stronger property than a stored password, and matches the contract's
phrasing of "a dedicated credential provisioned on the PC" well.

**It does not apply to WOLF's primary target.** Smart-card logon goes through Kerberos
PKINIT, which needs a KDC — a domain. There is no smart-card logon for local accounts. The
machine this was written on is `WORKGROUP`, and a personal PC being controlled remotely is
the case WOLF is for.

- **Cost, where it does apply:** AD Certificate Services, certificate enrolment per user, and
  WOLF holding the card's PIN — which is a WOLF-specific secret rather than the Windows
  password, so the requirement is met.
- **Verdict:** viable for domain-joined fleets, irrelevant for the product's main case.

## Where that leaves it

| Route | Meets "never the Windows password" | Works on a workgroup PC | Cost |
| --- | --- | --- | --- |
| 1. Operator types it on the lock screen | The password is typed, never stored | Yes | Small |
| 2. Credential provider replaying a stored password | No | Yes | Moderate |
| 3. Custom LSA authentication package | Yes | Yes | Microsoft-attested signing |
| 4. TPM virtual smart card | Yes | **No** (needs a domain) | AD CS + enrolment |

**The requirement as written is not achievable on a workgroup PC** without route 3, and route
3 is gated by a Microsoft signing programme rather than by engineering effort.

The honest options are therefore:

1. **Build route 1 and describe it accurately.** **Chosen, and built.** "You can reach the
   lock screen and sign in" is a real, useful capability and is what the feature means to
   most people. It does not satisfy `power.unlock` as specified, so `power.unlock` stays
   unimplemented and refused rather than being quietly redefined to mean something weaker.
2. **Take route 3 as a deliberate product decision**, with the signing programme as part of
   the plan.
3. **Offer route 4 for domain-joined machines only**, and say so — a capability that exists on
   some PCs and not others is fine as long as the handshake reports which.

What must not happen is `power.unlock` shipping as route 2 while the documentation still says
"never the Windows password". That would be the one kind of failure this project has
consistently refused: a true-sounding claim that the implementation does not support.

## Evidence

Gathered on the development machine, 2026-09-10:

- `RunAsPPL = 2` — LSA protection enforced, so lsass will not load an unsigned authentication
  package.
- `Authentication Packages = msv1_0` — stock, nothing custom present to model against.
- `PartOfDomain = False`, `Domain = WORKGROUP` — the smart-card route does not apply here.
- Registered credential providers are all Microsoft's: password, PIN, picture password, face,
  fingerprint, smart card, and the dynamic-lock and redeployment providers. A WOLF provider
  would be the only third-party one.
- `tpmvscmgr.exe` present, Windows 11 Pro build 26200.
