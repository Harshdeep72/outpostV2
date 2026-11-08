import { registerCommands } from "../bot/registerCommands.js";

async function main() {
  console.log("Registering commands with Discord API...");
  await registerCommands();
  console.log("Commands successfully registered!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error registering commands:", err);
  process.exit(1);
});
