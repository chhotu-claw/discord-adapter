import { SlashCommandBuilder } from "discord.js";
import type { Guild } from "discord.js";

export const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("Create a new agent session")
    .addStringOption((o) =>
      o
        .setName("agent")
        .setDescription("Agent to use (type to search installed agents)")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("workspace")
        .setDescription("Workspace directory (type to search your projects)")
        .setRequired(false)
        .setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName("newchat")
    .setDescription(
      "New chat in current thread, inheriting agent and workspace",
    ),

  new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Cancel the current session"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show session or global status"),

  new SlashCommandBuilder()
    .setName("sessions")
    .setDescription("List all sessions"),

  new SlashCommandBuilder()
    .setName("agents")
    .setDescription("List available agents"),

  new SlashCommandBuilder()
    .setName("install")
    .setDescription("Install an agent by name")
    .addStringOption((o) =>
      o
        .setName("name")
        .setDescription("Agent name to install")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("menu")
    .setDescription("Show the action menu"),

  new SlashCommandBuilder().setName("help").setDescription("Show help"),

  new SlashCommandBuilder()
    .setName("mode")
    .setDescription("Switch session mode (e.g. code, architect, ask)")
    .addStringOption((o) =>
      o.setName("value").setDescription("Mode to switch to").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Switch the AI model for this session")
    .addStringOption((o) =>
      o.setName("value").setDescription("Model to switch to").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("thought")
    .setDescription("Adjust how much the agent thinks before responding")
    .addStringOption((o) =>
      o.setName("value").setDescription("Thinking level").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("switch")
    .setDescription("Switch to a different agent for this session")
    .addStringOption((o) =>
      o
        .setName("agent")
        .setDescription("Agent name to switch to (omit to see menu)")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("tunnel")
    .setDescription("Create or stop a port tunnel")
    .addIntegerOption((o) =>
      o.setName("port").setDescription("Local port to tunnel").setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName("action")
        .setDescription("Action to perform")
        .setRequired(false)
        .addChoices({ name: "stop", value: "stop" }),
    )
    .addStringOption((o) =>
      o.setName("label").setDescription("Optional label for this tunnel").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("tunnels")
    .setDescription("List active port tunnels"),

  new SlashCommandBuilder()
    .setName("bypass")
    .setDescription("Auto-approve all permission requests (skip confirmations)"),

  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart OpenACP"),

  new SlashCommandBuilder()
    .setName("update")
    .setDescription("Update to the latest version"),

  new SlashCommandBuilder()
    .setName("integrate")
    .setDescription("Manage agent integrations"),

  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Show configuration settings"),

  new SlashCommandBuilder()
    .setName("doctor")
    .setDescription("Run system diagnostics"),

  new SlashCommandBuilder()
    .setName("handoff")
    .setDescription("Generate a terminal resume command for this session"),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Reset the assistant session"),

  new SlashCommandBuilder()
    .setName("tts")
    .setDescription("Toggle Text to Speech for the current session")
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription(
          "on = persistent, off = disable, empty = next message only",
        )
        .setRequired(false)
        .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
    ),

  new SlashCommandBuilder()
    .setName("outputmode")
    .setDescription("Set output detail level (low/medium/high)")
    .addStringOption((o) =>
      o
        .setName("level")
        .setDescription("Output mode level")
        .addChoices(
          { name: "🔇 Low — icons only", value: "low" },
          { name: "📊 Medium — balanced (default)", value: "medium" },
          { name: "🔍 High — full detail", value: "high" },
          { name: "🔄 Reset to default", value: "reset" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("scope")
        .setDescription("Apply to adapter or current session")
        .addChoices(
          { name: "Adapter default", value: "adapter" },
          { name: "This session only", value: "session" },
        ),
    ),

  // Deprecated: use /outputmode instead
  new SlashCommandBuilder()
    .setName("verbosity")
    .setDescription("Set display verbosity (deprecated, use /outputmode)")
    .addStringOption((o) =>
      o
        .setName("level")
        .setDescription("Verbosity level")
        .addChoices(
          { name: "🔇 Low — icons only", value: "low" },
          { name: "📊 Medium — balanced (default)", value: "medium" },
          { name: "🔍 High — full detail", value: "high" },
          { name: "🔄 Reset to default", value: "reset" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("scope")
        .setDescription("Apply to adapter or current session")
        .addChoices(
          { name: "Adapter default", value: "adapter" },
          { name: "This session only", value: "session" },
        ),
    ),
];

export async function registerSlashCommands(guild: Guild): Promise<void> {
  await guild.commands.set(SLASH_COMMANDS.map((cmd) => cmd.toJSON()));
}

export { handleSlashCommand, setupButtonCallbacks } from "./router.js";
export { buildMenuKeyboard } from "./menu.js";
