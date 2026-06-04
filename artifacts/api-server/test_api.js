import { config } from 'dotenv';
import { fetch } from 'undici';
config();
const osintUrl = process.env.REDDIT_OSINT_URL;
console.log("OSINT URL:", osintUrl);
async function run() {
  const c = await fetch(`${osintUrl}/api/external/check/comment?url=https://reddit.com/r/pics/comments/1ihk4u4/what_did_they_do_to_the_cat_noooo/m9l091b/`);
  console.log("Comment:", await c.json());
  const a = await fetch(`${osintUrl}/api/external/check/account?username=spez`);
  console.log("Account:", await a.json());
}
run();
