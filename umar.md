# Umar change log — backend

## Current changes

- Local MySQL setup and seeded development Admin account.
- Client profile API now supports `city` and JSON `interests`; client default commission was removed.
- Delete endpoints now return clear protected-record messages for clients, plots, and societies with linked data.

## QR guest access — in progress

- Added `QR_GUEST_MIGRATION.sql` for organisation QR tokens, guest contacts, and hashed guest sessions.
- Added secure public guest API endpoints for QR token resolution, guest registration/recognition, persistent device session cookies, and organisation-scoped inventory.
- Added CORS support for credentialed guest-session requests across the frontend/backend ports.
- Frontend public guest experience and QR-management screen are implemented; final device-flow verification is pending.
- QR guest registration now also creates or updates the organisation's normal client record (without a photo); guest-device sessions remain separate.
- CNIC is optional. The numeric client ID remains the primary key, while `(organization_id, phone_number)` prevents a duplicate client only within the same organisation; QR scans silently reuse that scoped client.
- Added an Inventory schema migration for the Houses and Price Categories features, including `client_plot.house_id` for house sales and purchases.
