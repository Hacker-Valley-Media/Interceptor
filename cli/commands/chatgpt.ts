/**
 * cli/commands/chatgpt.ts — slop chatgpt: drive ChatGPT as an agentic system
 *
 * Subcommands that need the daemon return an Action object.
 * Orchestration (chatgpt_send, etc.) is handled in cli/index.ts after dispatch.
 */

type Action = { type: string; [key: string]: unknown }

function flagPresent(args: string[], flag: string): boolean {
  return args.indexOf(flag) !== -1
}

export async function parseChatgptCommand(filtered: string[], jsonMode = false): Promise<Action | null> {
  const sub = filtered[1]
  if (!sub || sub === "help") {
    console.log(CHATGPT_HELP)
    return null
  }

  switch (sub) {
    case "send": {
      const prompt = filtered.slice(2).filter(a => !a.startsWith("--")).join(" ")
      if (!prompt) {
        console.error('error: slop chatgpt send requires a prompt. Example: slop chatgpt send "What is 2+2?"')
        process.exit(1)
      }
      const stream = flagPresent(filtered, "--stream")
      return { type: "chatgpt_send", prompt, stream }
    }
    case "read":
      return { type: "chatgpt_read" }
    case "status":
      return { type: "chatgpt_status" }
    case "conversations":
      return { type: "chatgpt_conversations" }
    case "switch": {
      const id = filtered[2]
      if (!id) {
        console.error("error: slop chatgpt switch requires a conversation ID.")
        process.exit(1)
      }
      return { type: "chatgpt_switch", conversationId: id }
    }
    case "model": {
      const name = filtered[2]
      return { type: "chatgpt_model", name }
    }
    case "stop":
      return { type: "chatgpt_stop" }
    default:
      console.error(`error: unknown chatgpt subcommand '${sub}'. Try: send, read, status, conversations, switch, model, stop.`)
      process.exit(1)
  }
}

const CHATGPT_HELP = `slop chatgpt — drive ChatGPT as an agentic system

Usage:
  slop chatgpt send "<prompt>"           Send a message and read the response
    --stream                             Print tokens as they stream
  slop chatgpt read                      Read current conversation from DOM
  slop chatgpt status                    Streaming state, model, conversation ID
  slop chatgpt conversations             List recent conversations
  slop chatgpt switch <id>               Navigate to a conversation
  slop chatgpt model [name]              Read or change the active model
  slop chatgpt stop                      Stop current generation

send      Types the prompt into ChatGPT, presses Enter, reads the SSE response.
          With --stream, prints tokens as they arrive.
          Without --stream, waits for completion and prints the full response.
read      Extracts conversation text from the DOM (fallback when SSE unavailable).
status    Shows whether ChatGPT is currently streaming, the active model,
          and the conversation ID from the URL.
`
