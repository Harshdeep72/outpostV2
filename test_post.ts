import { validateRedditProof } from "./artifacts/api-server/src/bot/reddit-validator.ts";

async function main() {
  const proofUrl = "https://www.reddit.com/r/crystalsingingbowl/comments/1tuludz/spiritual_alignment_is_honestly_a_whole/?share_id=s17G2qqHNDoiaocOjYAlC&utm_content=2&utm_medium=android_app&utm_name=androidcss&utm_source=share&utm_term=1";
  console.log(`Validating: ${proofUrl}`);
  
  // Fake context where task is "post" and task link is just the subreddit URL
  const taskRedditLink = "https://www.reddit.com/r/crystalsingingbowl/";
  
  const res = await validateRedditProof(
    proofUrl, 
    ["Comi9689"], // Expected author (user's reddit name from context)
    taskRedditLink,
    { taskType: "post" }
  );
  
  console.log(JSON.stringify(res, null, 2));
}

main().catch(console.error);
