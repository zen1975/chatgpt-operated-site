# Google Drive Asset Intake Setup

Use this guide when a new installation enables Google Drive as its Asset Intake
provider. Google Drive is a temporary intake bridge. It is not the public asset
origin: validated binaries are ingested into R2 and their metadata is stored in
D1 before the site serves them.

Google Drive is optional. Skip this guide when the installation uses only
existing canonical `assetId` values or another configured provider.

## 1. Choose one credential source

Configure exactly one Worker credential source.

| Source | Worker secrets | Use |
| --- | --- | --- |
| Service account | `GOOGLE_DRIVE_SA_CLIENT_EMAIL`, `GOOGLE_DRIVE_SA_PRIVATE_KEY` | Recommended for server-to-server installation access. |
| OAuth refresh token | `GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` | Use when access must belong to a user account. |
| Static access token | `GOOGLE_DRIVE_ACCESS_TOKEN` | Short-lived verification only. |

Do not configure multiple sources as fallback credentials. The readiness result
must describe the same identity that the mutation path will use.

## 2. Create the intake folder

1. Create a dedicated folder in the installation owner's Google Drive.
2. Give it a stable name such as **Asset Intake**.
3. Record its folder ID from the Drive URL.
4. Give the chosen Worker identity read access to that folder.
5. Give the ChatGPT-facing upload integration only the access it needs to place
   files in that folder.

Do not discover the folder by name at operation time. Store the verified folder
ID in the installation configuration.

## 3. Enable the Drive API

In the installation's Google Cloud project:

1. Enable the Google Drive API.
2. Create credentials for the single source selected above.
3. Limit the credential to the installation and keep credential material out of
   the repository.
4. Use the read-only Drive scope:

   ```text
   https://www.googleapis.com/auth/drive.readonly
   ```

The Worker reads folder metadata, lists the intake folder during readiness, and
fetches referenced file metadata and bytes. It does not upload to Drive.

### Service-account setup

1. Create a service account in the installation's Google Cloud project.
2. Create a JSON key for that service account.
3. Share the Asset Intake folder with the service-account email as a viewer.
4. Store the JSON `client_email` and `private_key` values as the two Worker
   secrets listed above.
5. Delete any unnecessary local copy of the downloaded key after the secrets
   have been provisioned according to the installation's credential policy.

Domain-wide delegation is not required. The service account should see only
folders explicitly shared with it.

### OAuth refresh-token setup

1. Configure an OAuth client owned by the installation.
2. Authorize the account that can read the Asset Intake folder with offline
   access and the read-only Drive scope.
3. Store the client ID, client secret, and resulting refresh token as the three
   Worker secrets listed above.
4. Confirm that the OAuth application's publication and user-access settings are
   suitable for the installation's expected lifetime.

Do not commit OAuth values or copy credentials from another site.

## 4. Configure the site profile

Update `config/site-profile.json` with installation-owned values:

```json
{
  "operations": {
    "assetIntake": {
      "provider": "google_drive",
      "stableId": "REPLACE_WITH_VERIFIED_DRIVE_FOLDER_ID",
      "displayName": "Asset Intake",
      "configurationStatus": "configured",
      "readinessPath": "/api/control/readiness/asset-intake/"
    }
  }
}
```

`stableId` is the canonical folder ID. It must identify the same folder shared
with the selected Worker identity.

## 5. Provision Worker secrets

After `wrangler.jsonc` points at the installation's Worker, provision only the
selected credential set.

Service account:

```bash
npx wrangler secret put GOOGLE_DRIVE_SA_CLIENT_EMAIL
npx wrangler secret put GOOGLE_DRIVE_SA_PRIVATE_KEY
```

OAuth refresh token:

```bash
npx wrangler secret put GOOGLE_DRIVE_CLIENT_ID
npx wrangler secret put GOOGLE_DRIVE_CLIENT_SECRET
npx wrangler secret put GOOGLE_DRIVE_REFRESH_TOKEN
```

Static verification token:

```bash
npx wrangler secret put GOOGLE_DRIVE_ACCESS_TOKEN
```

Also provision the command and control secrets described in
`docs/CONFIGURATION.md`. Never place secret values in command JSON, logs,
configuration files, pull requests, or screenshots.

## 6. Verify before client handoff

1. Run `npm ci` and `npm run verify`.
2. Deploy the installation after its D1, R2, KV, variables, migrations, and
   Worker secrets are configured.
3. Prepare a schema-valid image-bearing Command using a Google Drive provider
   reference and the installation's current `targetSite` and rule version.
4. Keep `context.requiresAssetIntake: true` as operation metadata.
5. Run the selected canonical dispatch path in dry-run mode.
6. Confirm that Asset Intake readiness is `READY`.
7. Dispatch a disposable acceptance Command only after dry-run succeeds.
8. Confirm that the resulting canonical Asset ID exists and that the public site
   serves the rendered image from the installation's asset endpoint, not Drive.

The reference dispatch adapter derives the readiness requirement from the
validated provider reference. The metadata flag does not replace that check. A
Command using an existing canonical `assetId` does not require a new Drive
intake.

## 7. Fail closed

Stop the workflow when readiness or ingestion reports an error. In particular,
do not:

- switch to another folder or provider without an installation decision
- remove Asset Intake metadata to bypass readiness
- publish text first when the requested operation requires an image
- write directly to D1 or R2
- reuse another site's folder ID or credentials
- overwrite a failed immutable Command

Correct the installation configuration or credentials, then create a new
Command according to the current schema and operating policy.

Common readiness failures include missing credentials, an inaccessible or
invalid folder, a token-exchange failure, and a folder that the selected
identity cannot list. The readiness endpoint returns a verdict and never returns
credential values.

## 8. Handoff boundary

Before handoff, record for the installation:

- which single credential source is active
- who owns the Google Cloud project and Drive folder
- the canonical folder ID in `config/site-profile.json`
- which ChatGPT-facing integration uploads files
- which canonical dispatch path is used
- the successful image-bearing acceptance result

Do not record secret values. Each client installation owns its credentials and
must complete its own end-to-end acceptance.
