export function visibleContent(item) {
  const result = { ...item };
  const fields = {
    title: ["title"], text: ["text"], image: ["imageFile", "imageUrl", "imageAlt", "imageWidth"],
    prizes: ["prizes"], info: ["info"], link: ["linkUrl", "linkLabel"],
  };
  for (const [section, keys] of Object.entries(fields)) {
    if (item.visibility?.[section] !== false) continue;
    for (const key of keys) result[key] = key === "prizes" ? [] : key === "imageWidth" ? undefined : "";
  }
  delete result.visibility;
  return result;
}
