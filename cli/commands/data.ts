/**
 * cli/commands/data.ts — cookies, storage, history, bookmarks, downloads, clear, clipboard
 */

type Action = { type: string; [key: string]: unknown }

export function parseDataCommand(filtered: string[]): Action {
  const cmd = filtered[0]

  switch (cmd) {
    case "cookies":
      switch (filtered[1]) {
        case "set":
          return { type: "cookies_set", cookie: JSON.parse(filtered[2]) }
        case "delete":
          return { type: "cookies_delete", url: filtered[2], name: filtered[3] }
        default:
          return { type: "cookies_get", domain: filtered[1] }
      }

    case "storage":
      if (filtered[1] === "set") {
        return {
          type: "storage_write",
          key: filtered[2],
          value: filtered[3],
          storageType: filtered.includes("--session") ? "session" : "local"
        }
      } else if (filtered[1] === "delete") {
        return {
          type: "storage_delete",
          key: filtered[2],
          storageType: filtered.includes("--session") ? "session" : "local"
        }
      } else {
        return {
          type: "storage_read",
          key: filtered[1],
          storageType: filtered.includes("--session") ? "session" : "local"
        }
      }

    case "history":
      if (filtered[1] === "delete") {
        return { type: "history_delete", url: filtered[2] }
      } else {
        return {
          type: "history_search",
          query: filtered[1] || "",
          maxResults: filtered[2] ? parseInt(filtered[2]) : 20
        }
      }

    case "bookmarks":
      if (filtered[1] === "add") {
        return { type: "bookmark_create", title: filtered[2], url: filtered[3] }
      } else if (filtered[1] === "delete") {
        return { type: "bookmark_delete", id: filtered[2] }
      } else if (filtered[1] === "tree") {
        return { type: "bookmark_tree" }
      } else {
        return { type: "bookmark_search", query: filtered[1] || "" }
      }

    case "downloads":
      if (filtered[1] === "start") {
        return { type: "downloads_start", url: filtered[2], filename: filtered[3] }
      } else if (filtered[1] === "cancel") {
        return { type: "downloads_cancel", downloadId: parseInt(filtered[2]) }
      } else {
        return { type: "downloads_search", query: filtered[1] }
      }

    case "clear":
      return {
        type: "browsing_data_remove",
        types: filtered.slice(1),
        since: filtered.includes("--since")
          ? parseInt(filtered[filtered.indexOf("--since") + 1])
          : 0
      }

    case "clipboard":
      if (filtered[1] === "write") {
        return { type: "clipboard_write", text: filtered.slice(2).join(" ") }
      } else {
        return { type: "clipboard_read" }
      }

    default:
      console.error(`error: unknown data command '${cmd}'`)
      process.exit(1)
  }
}
