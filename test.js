const text = `https://www.reddit.com/r/7_hydroxymitragynine/comments/1tvykq3/finding_an_online_vendor_that_actually_keeps/

https://www.reddit.com/r/Kratom_7OH/comments/1twhxnl/how_online_vendors_are_adjusting_to_the_shifting/?share_id=jy7hdDf52mwf1Iwvd00Ps&utm_content=2&utm_medium=android_app&utm_name=androidcss&utm_source=share&utm_term=1`;

const urls = text.split(/\r?\n|,|\s+/g).map((s) => s.trim()).filter((s) => s.length > 0);
console.log("frontend urls:", urls);
