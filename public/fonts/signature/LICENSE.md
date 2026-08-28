# Signature cursive faces — SIL Open Font License 1.1

The `.woff2` files in this directory are the unmodified `latin` and `latin-ext`
subsets published by Google Fonts, fetched by
[`scripts/fetch-signature-fonts.mjs`](../../../scripts/fetch-signature-fonts.mjs)
and served from this app's own origin. They back the **Type** mode of the
Documents signature pad — see `docs/features/documents-tab.md` § "Draw or Type".

They are self-hosted rather than loaded from the Google CDN on purpose: canvas
2D does not report a missing font, so a CDN miss would silently rasterise and
save a signature that is not cursive. Removing the network from that path is a
correctness guard, not a performance choice.

| Face | Copyright |
| --- | --- |
| Great Vibes | © The Great Vibes Project Authors |
| Allura | © The Allura Project Authors |
| Sacramento | © The Sacramento Project Authors |
| Dancing Script | © The Dancing Script Project Authors |
| Caveat | © The Caveat Project Authors |
| Homemade Apple | © The Homemade Apple Project Authors |

All six are licensed under the SIL Open Font License, Version 1.1. The licence
permits embedding and redistribution provided the copyright notice and licence
travel with the font — which is what this file is for.

Full licence text: <https://openfontlicense.org/open-font-license-official-text/>

Each family name is a Reserved Font Name. These copies are unmodified, so they
keep their names, must remain OFL-licensed, and must not be sold on their own.
