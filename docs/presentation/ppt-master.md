# PPT Master integration

Source: https://github.com/hugohe3/ppt-master/tree/main/skills/ppt-master
Version used: 6.7.0. Copyright (c) 2025-2026 Hugo He. MIT license preserved in `ppt-master-LICENSE.txt`.

The complete upstream Codex skill is installed at `C:/Users/ADMIN/.codex/skills/ppt-master`. It is available to Codex on the next turn. The application does not execute downloaded Python scripts or import the skill's entire asset library at runtime.

Color method: each style provides a coordinated five-hue family instead of one accent. AI assigns semantic roles (`anchor`, `cool`, `warm`, `fresh`, `neutral`); the backend enforces at least three roles for decks of four or more slides when the AI plan is weak. Backgrounds use paper, tinted and anchor fields; cards rotate related tints rather than repeating one fill. Contrast is derived from background luminance. This is a reusable method/default, not a fixed brand identity.

Design principles adapted from `references/executor-base.md`, `references/strategist.md` and `workflows/generate-pptx.md`: one page job, visible title/body hierarchy, generous whitespace, stable palette and typography, narrative opening/closing, and varied composition instead of a repeated generic grid. No invented facts, charts or metrics.

Runtime implementation lives in `backend/src/modules/presentation/presentation-design.service.js` and `presentation-pptx.service.js`. The AI selects optional `layout` and `colorRole`; the media planner selects an optional placement including a full-bleed image background. The native PptxGenJS exporter renders editable text/shapes and notes, varies multi-hue page color by semantic role, uses per-card tints, applies contrast-aware text, places full-bleed imagery behind a scrim, preserves raster aspect ratios, adapts long content, and preserves older decks with automatic defaults. This is an adaptation into the existing web application, not the upstream SVG authoring pipeline or every capability of PPT Master.

Media stays optional. After checking the AI plan, **Tạo toàn bộ minh họa theo kế hoạch** submits selected slide requests sequentially, reuses completed assets and existing jobs, shows progress/errors, and can stop before the next slide. Videos continue asynchronously and update automatically. Stop does not cancel an already submitted paid provider job. Retry skips successful/submitted media and only retries missing/failed items. Editing the outline during a batch stops subsequent requests.
