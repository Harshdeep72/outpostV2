import { recheckRedditLiveness } from "../bot/reddit-validator.js";

async function main() {
  const testUrl = "https://www.reddit.com/r/careerguidance/comments/1xp0snz/comment/19s7wkcm96m1w/";
  console.log("Checking test URL:", testUrl);
  const res = await recheckRedditLiveness(testUrl);
  console.log("Result:", JSON.stringify(res, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
