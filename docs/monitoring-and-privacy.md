# Monitoring, privacy & the law

Bastion can record connection metadata and — if you enable it — the domain names users look
up. That capability carries real legal and ethical weight. **Read this before turning on any
logging.** This page is guidance, not legal advice; consult a qualified professional for your
situation.

## What you can record

- Per-user data volumes and connection times (always).
- Source address, approximate location and provider of each connection (always).
- The domain names each user's device looks up, when `LOG_WEBSITES="yes"`.

Full detail: [What is recorded](what-is-recorded.md).

## Core principles

1. **Only monitor people who know and, where required, have agreed.** Covert monitoring of
   employees, family members, guests or customers is unlawful in many jurisdictions.
2. **Have a lawful basis and a stated purpose.** "Security and troubleshooting" is common for
   a corporate VPN; browsing surveillance for its own sake is not.
3. **Give notice.** Tell users what is recorded, why, how long it is kept, and who can see it.
   The generated end-user PDF guide includes a plain-language "what is recorded" section — keep
   it accurate and actually deliver it.
4. **Minimise.** Record the least you need. If you don't need the website log, leave
   `LOG_WEBSITES="no"`. Keep retention short.
5. **Restrict access.** Use the viewer role for people who should see activity but not change
   anything, and keep administrator accounts few.
6. **Secure the data.** The logs include personal data; protect the management machine and
   backups accordingly.

## Jurisdiction matters

Laws such as the GDPR (EU/UK), PIPEDA (Canada), CCPA/CPRA (California), ECPA/Wiretap Act (US),
and workplace-surveillance and wiretapping statutes elsewhere may all apply. Rules differ
sharply by country, by employment vs. personal context, and by whether users consented.

## Retention & deletion

All recorded data expires automatically on the retention schedules
([Administration → Settings](administration.md)). Set them to the shortest period that meets
your needs, and delete data you no longer require.

## A note on blocking

Website blocking is global and DNS-based. Use it for its stated purpose (e.g. malware/ads on a
corporate VPN), tell users it is in place, and remember it can be bypassed — it is not a
security guarantee.

> If you cannot clearly explain to your users what you record and why, do not record it.
