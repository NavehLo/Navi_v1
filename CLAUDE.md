@AGENTS.md

# UI text must be readable

The app is used outdoors, on a phone, often in sunlight, on dark translucent panels.
Every piece of text — explanations, notes, numbers, hints — must be clearly readable:

- Default to white (`text-white`) on the dark panels. Do not use light grey on black
  (`text-zinc-400`, `text-zinc-500`, `text-zinc-600`) for anything the user is meant to read.
  Colour is fine for emphasis (amber for warnings, yellow/sky for key numbers) as long as it is bright.
- Minimum size for readable text is `text-xs` (12px); body text in panels is `text-sm`.
  `text-[10px]` / `text-[11px]` only for tiny labels that are not essential.
- When touching an existing panel, fix any low-contrast text in the part you changed.
