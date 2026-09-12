# Asset Intake Setup (Google Drive)

`docs/CONFIGURATION.md` lists the environment names the runtime reads. That is
not enough to reproduce the image half of the Golden Path: it does not say how
to obtain those values, where the intake folder comes from, or which step is
most often missed.

This page is the provisioning procedure. Follow it once per installation.

Skip this page entirely if the installation does not publish images. Asset
Intake is optional and the text Golden Path does not depend on it.

If the installation does publish images, this is the path: **Google Drive is
the only provider the reference readiness flow supports.** The `generated`
adapter exists for implementers with their own artifact origin and their own
gate, and does not pass this one. See `docs/DISPATCH_REFERENCE.md`.

---

## What is being built

```text
Requester uploads an image
  ↓
Google Drive intake folder            <- one folder, fixed id
  ↓
Worker reads the file by its Drive id <- one credential, read-only
  ↓
R2 + assets row                       <- ingested, checksummed, sized
```

The Worker never browses Drive. It reads one folder, identified by a stable id
recorded in `config/site-profile.json`.

---

## 1. Create the intake folder

1. Create a folder in Google Drive. Any name; `Asset Intake` is conventional.
2. Open it and copy the id from the address bar:
   `https://drive.google.com/drive/folders/<THIS IS THE FOLDER ID>`
3. Put that id in `config/site-profile.json`:

```json
"operations": {
  "assetIntake": {
    "provider": "google_drive",
    "stableId": "<folder id>",
    "configurationStatus": "configured"
  }
}
```

The id is not a secret. It is committed, like the rest of the site profile.

---

## 2. Choose one credential source

Configure exactly one. The runtime does not merge them.

| Source | Use it when |
| --- | --- |
| Service account (`GOOGLE_DRIVE_SA_CLIENT_EMAIL`, `GOOGLE_DRIVE_SA_PRIVATE_KEY`) | Normal installations. No token expiry to manage, no human account involved. |
| OAuth refresh token (`GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`) | The files must stay in a person's own Drive and a service account cannot be shared into it. |
| Static access token (`GOOGLE_DRIVE_ACCESS_TOKEN`) | Verification only. It expires within the hour. |

### Service account (recommended)

1. In the Google Cloud console, select or create a project.
2. Enable the **Google Drive API** for that project.
3. Create a **service account**. No project roles are required: Drive access is
   granted by sharing the folder, not by IAM. Domain-wide delegation is not
   required either — the service account should see only the folders explicitly
   shared with it.
4. Create a **JSON key** for that service account and download it.
5. From the JSON, take `client_email` and `private_key`.

The private key contains literal `\n` escapes. Store it with the newlines
intact:

```bash
# from the downloaded key file
node -e "process.stdout.write(require('./key.json').private_key)" \
  | wrangler secret put GOOGLE_DRIVE_SA_PRIVATE_KEY

node -e "process.stdout.write(require('./key.json').client_email)" \
  | wrangler secret put GOOGLE_DRIVE_SA_CLIENT_EMAIL
```

Delete the downloaded key file afterwards. Do not commit it; do not paste it
into chat or email.

### OAuth refresh token

Create an OAuth client of type *Desktop app*, complete the consent flow with
scope `https://www.googleapis.com/auth/drive.readonly`, and store the resulting
refresh token together with the client id and client secret. All three are
required; a refresh token alone cannot mint an access token.

---

## 3. Share the folder with the identity

**This is the step that is missed most often.** Credentials that are valid in
every other respect still fail here, and the failure looks like a permissions
bug rather than a setup omission.

- **Service account:** open the intake folder, choose Share, and add the service
  account's `client_email` address as a **Viewer**. A service account is a
  principal like any other; until it is shared in, the folder does not exist as
  far as it is concerned.
- **OAuth refresh token:** the folder must be owned by, or shared with, the
  account that granted consent.

A folder inside a shared drive also requires the identity to be a member of that
shared drive.

---

## 4. Verify before dispatching anything

Readiness is reported by an authenticated control-plane route. It returns a
verdict and never echoes credential values.

```
GET /api/control/readiness/asset-intake/
```

Dispatch it through the GitHub Actions gate, not from ChatGPT. A pass means the
runtime can resolve the folder *and* list it; an empty folder still passes,
because the capability is what is being checked.

| Code | Meaning |
| --- | --- |
| `ASSET_INTAKE_NOT_CONFIGURED` | No credential source is set, or `stableId` is still the placeholder. |
| `ASSET_INTAKE_STABLE_ID_INVALID` | `stableId` is not a Drive file id. A full URL was probably pasted instead of the id. |
| `ASSET_INTAKE_STABLE_ID_NOT_FOLDER` | The id resolves to a file, not a folder. |
| `DRIVE_INTAKE_FOLDER_MISMATCH` | The id resolved to something else, or the identity cannot see it. Re-check step 3. |

Only after this returns a pass is the image Golden Path reproducible.

---

## 5. Everyday use

The requester puts a file in the folder and refers to it. The operator passes a
`google_drive` asset reference; ingestion validates the MIME type, computes a
checksum, reads the dimensions, and writes to R2.

Nothing else in Drive is reachable. Widening access means sharing another
folder, not changing the credential.
