# Design QA

Source visual truth: `/private/var/folders/4w/1qngh5xj1f58v57pqwgd252m0000gn/T/codex-clipboard-fbc40600-7d63-4f34-a3a1-9dad6688a001.png` and `/private/var/folders/4w/1qngh5xj1f58v57pqwgd252m0000gn/T/codex-clipboard-ce16a5ae-192d-48cc-a747-ff35af118473.png`.

Implementation evidence: native app capture from the CUA test, `1204 x 768` CSS pixels, macOS desktop, dark mode. The source references are `281 x 143` and `743 x 654`; they illustrate interaction placement rather than a same-size screen, so no density normalization was applied.

State checked: existing conversation, collapsed tool launcher, then expanded launcher.

**Findings**

- The app keeps its existing dark palette rather than copying the reference application's white palette. This is an intentional product-theme difference, not a fidelity defect.
- The launcher is in the requested location: a single upper-right `sidebar.right` control. Its verified popover contains only **文件**, **浏览器**, and **终端**. The workspace panel is shown only after choosing one.
- The composer exposes native attachment selection and drop handling, with image thumbnails or compact filename chips instead of inserting filesystem paths. Thought and tool rows use collapsed disclosure controls by default.

**Focused comparison**

Focused on the upper-right launcher because it is the shared, visible interaction from the source captures. The implementation retains the reference's on-demand three-item menu, using native macOS controls and the app's dark tokens. A second visual region was unnecessary: attachment chips and collapsed transcript rows are newly specified behavior without matching reference pixels.

**Implementation checklist**

- [x] Move the launcher to the application toolbar.
- [x] Reveal the three tool choices only on demand.
- [x] Keep process detail collapsed by default.
- [x] Render pasted/dropped attachments as attachments.

Final result: passed
