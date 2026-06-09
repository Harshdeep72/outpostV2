const urls = [
  "https://www.reddit.com/r/7_hydroxymitragynine/comments/1tvykq3/finding_an_online_vendor_that_actually_keeps/",
  "https://www.reddit.com/r/Kratom_7OH/comments/1twhxnl/how_online_vendors_are_adjusting_to_the_shifting/?share_id=jy7hdDf52mwf1Iwvd00Ps&utm_content=2",
  "https://www.reddit.com/r/Kratom_7OH/comments/1twhxnl/how_online_vendors_are_adjusting_to_the_shifting/abcdefg/?share_id=123",
  "https://www.reddit.com/r/Kratom_7OH/comment/abcdefg/",
  "https://www.reddit.com/r/Kratom_7OH/comments/1twhxnl/how_online_vendors_are_adjusting_to_the_shifting"
];

for (const url of urls) {
  // Strip query string first for safer splitting
  const cleanUrl = url.split("?")[0].replace(/\/$/, ""); 
  // e.g. https://.../comments/1tvykq3/finding...
  
  const isComment = cleanUrl.includes("/comment/") || 
                   (cleanUrl.includes("/comments/") && cleanUrl.split("/comments/")[1].split("/").length >= 3);
  
  console.log(isComment, " -> ", url);
}
