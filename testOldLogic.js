const urls = [
  "https://www.reddit.com/r/JustTaxLand/comments/1ttu6lk/the_ultimate_visual_metaphor_for_urban_urban/", // Has trailing slash
  "https://www.reddit.com/r/JustTaxLand/comments/1ttu6lk/the_ultimate_visual_metaphor_for_urban_urban"  // No trailing slash
];

for (const url of urls) {
  // Old logic
  const isCommentOld = url.includes("/comment/") || url.includes("/comments/") && url.split("/comments/")[1].split("/").length >= 3;
  
  // New logic
  const cleanUrl = url.split("?")[0].replace(/\/$/, "");
  const isCommentNew = cleanUrl.includes("/comment/") || 
                      (cleanUrl.includes("/comments/") && cleanUrl.split("/comments/")[1].split("/").length >= 3);
                      
  console.log("URL:", url);
  console.log("  Old ->", isCommentOld ? "Comment" : "Post");
  console.log("  New ->", isCommentNew ? "Comment" : "Post");
}
