# CWS Submission Runbook (v1.0.3)

Use this sequence in Chrome Web Store dashboard to minimize review friction.

## 1) Upload package

- Upload ZIP:
  `release/browseagent-v1.0.3-chrome-web-store.zip`
- Confirm package accepted with no schema errors.

## 2) Store listing fields

Paste values from:

`docs/CWS_DASHBOARD_CONTENT_v1.0.3.md`

Required fields to fill:
- Single purpose
- Short description
- Detailed description
- Support email: `kazkozdev@gmail.com`
- Category/language/visibility

## 3) Privacy & disclosures

- Privacy policy URL:
  `https://raw.githubusercontent.com/KazKozDev/browser-agent-chrome-extension/main/PRIVACY.md`
- Complete Data usage questionnaire using the same doc above.
- Ensure permissions rationale appears in description/supporting text.

## 4) Upload assets

Upload from `store-assets/v1.0.3/`:
- `store-icon-128x128.png`
- `screenshot-1280x800.png`
- `small-promo-440x280.png`
- `marquee-1400x560.png`

## 5) Draft review warnings

If CWS shows warnings, resolve them before submit. Most likely warning areas:
- Broad host permissions (`<all_urls>`)
- Use of cookies
- Background execution / alarms

Use the prepared permission rationale text from
`docs/CWS_DASHBOARD_CONTENT_v1.0.3.md`.

## 6) Final submit gate

Submit only when all are true:
- ZIP uploaded successfully
- Listing fields completed
- Privacy URL set
- Data usage completed
- Assets uploaded
- No unresolved blocking warnings
