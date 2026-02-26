# Chrome Web Store Release Checklist (v1.0.2)

Date: February 25, 2026

## Build/package

- [x] Manifest version is `1.0.2`
- [x] Extension tests pass (`node --test`)
- [x] Store upload ZIP prepared:
  `release/browseagent-v1.0.2-chrome-web-store.zip`
- [x] ZIP includes runtime files only (`manifest.json`, `src/`, `icons/`, `_locales/`, `LICENSE`)

## Policy/readiness

- [x] Privacy policy file added: `PRIVACY.md`
- [ ] Publish privacy policy at a public URL and add it in CWS dashboard
- [ ] Complete CWS “Data usage” disclosures to match real behavior
- [ ] Ensure store listing explains why broad permissions are required

## Store listing assets

- [x] Extension icon 128x128 exists (`icons/icon128.png`)
- [x] Store icon asset prepared: `store-assets/v1.0.2/store-icon-128x128.png`
- [x] Listing screenshot prepared: `store-assets/v1.0.2/screenshot-1280x800.png`
- [x] Promotional assets prepared:
  `store-assets/v1.0.2/small-promo-440x280.png`,
  `store-assets/v1.0.2/marquee-1400x560.png`
- [ ] Upload prepared assets to CWS listing form

## CWS dashboard fields

- [ ] Single purpose clearly described
- [ ] Description and support email set
- [ ] Category/language set
- [ ] Visibility and distribution settings reviewed

## Submission

- [ ] Upload `release/browseagent-v1.0.2-chrome-web-store.zip`
- [ ] Fix any automated warnings in draft review
- [ ] Submit for review
