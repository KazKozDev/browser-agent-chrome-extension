# Chrome Web Store Release Checklist (v1.0.3)

Date: March 14, 2026

## Build/package

- [x] Manifest version is `1.0.3`
- [x] Extension tests pass (`node --test`)
- [x] Store upload ZIP prepared:
  `release/browseagent-v1.0.3-chrome-web-store.zip`
- [x] ZIP includes runtime files only (`manifest.json`, `src/`, `icons/`, `_locales/`, `LICENSE`)

## Policy/readiness

- [x] Privacy policy file added: `PRIVACY.md`
- [x] Public privacy policy URL is available:
  `https://raw.githubusercontent.com/KazKozDev/browser-agent-chrome-extension/main/PRIVACY.md`
- [ ] Add privacy policy URL in CWS dashboard
- [ ] Complete CWS “Data usage” disclosures to match real behavior
- [ ] Ensure store listing explains why broad permissions are required

## Store listing assets

- [x] Extension icon 128x128 exists (`icons/icon128.png`)
- [x] Store icon asset prepared: `store-assets/v1.0.3/store-icon-128x128.png`
- [x] Listing screenshot prepared: `store-assets/v1.0.3/screenshot-1280x800.png`
- [x] Promotional assets prepared:
  `store-assets/v1.0.3/small-promo-440x280.png`,
  `store-assets/v1.0.3/marquee-1400x560.png`
- [ ] Upload prepared assets to CWS listing form

## CWS dashboard fields

- [x] Prepared copy for dashboard fields and disclosures:
  `docs/CWS_DASHBOARD_CONTENT_v1.0.3.md`
- [ ] Single purpose clearly described
- [ ] Description and support email set
- [ ] Category/language set
- [ ] Visibility and distribution settings reviewed

## Submission

- [ ] Upload `release/browseagent-v1.0.3-chrome-web-store.zip`
- [ ] Fix any automated warnings in draft review
- [ ] Submit for review
