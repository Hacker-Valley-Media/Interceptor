# macOS

## Start with the compound surface

```bash
interceptor macos open "Finder"
interceptor macos read
interceptor macos act e5
interceptor macos inspect
```

- Use the compound commands first for native-app exploration, the same way you use `open`, `read`, `act`, and `inspect` in the browser.

## Use the AX tree before raw input

- Use `tree`, `find`, `focused`, `value`, `action`, and `windows` to understand the frontmost app.
- Use `click`, `type`, `keys`, `scroll`, `drag`, `move`, and `resize` when the tree exposes the needed target.
- Let Interceptor escalate to CGEvent input when AX actions are insufficient, or use the direct trusted input command when precision matters.

## Check permissions before claiming success

- Run `interceptor macos trust` when the task depends on Accessibility, Screen Recording, or Microphone access.
- Expect screenshots, streaming, speech recognition, OCR, and sound classification to fail or degrade when permissions are missing.

## Use the native-only capabilities deliberately

- Use `menu` for deterministic menu traversal.
- Use `monitor` to learn native desktop workflows and export replayable plans.
- Use `vision`, `nlp`, `listen`, `vad`, `sounds`, `audio`, `display`, and `stream` only when the task explicitly benefits from those surfaces.

## Keep boundaries clear

- Use browser `interceptor` commands for web content.
- Use `interceptor macos` for native apps, browser chrome, OS dialogs, or trusted input that must bypass DOM simulation.
