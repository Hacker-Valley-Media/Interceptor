// Files the CLI embeds with `with { type: "file" }`: the import is the embedded file's path.
declare module "*.ttf" { const path: string; export default path }
declare module "*.png" { const path: string; export default path }
