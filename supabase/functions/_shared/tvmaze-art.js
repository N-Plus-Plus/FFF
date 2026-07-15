function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function integerValue(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function candidateFromImage(item, kind, resolutionOrder) {
  if (!item || String(item.type || "").toLowerCase() !== kind) {
    return null;
  }
  const resolutions = item.resolutions && typeof item.resolutions === "object" ? item.resolutions : {};
  for (const resolutionName of resolutionOrder) {
    const resolution = resolutions[resolutionName] && typeof resolutions[resolutionName] === "object"
      ? resolutions[resolutionName]
      : {};
    const url = stringValue(resolution.url);
    if (url) {
      return {
        type: kind,
        sourceUrl: url,
        width: integerValue(resolution.width) || null,
        height: integerValue(resolution.height) || null,
        main: Boolean(item.main),
        source: "tvmaze_images"
      };
    }
  }
  return null;
}

function selectByType(images, kind, resolutionOrder) {
  const candidates = (Array.isArray(images) ? images : [])
    .map((item) => candidateFromImage(item, kind, resolutionOrder))
    .filter(Boolean);
  return candidates.find((item) => item.main) || candidates[0] || null;
}

export function selectTvmazeCardArt(show, images) {
  const background = selectByType(images, "background", ["original"]);
  if (background) {
    return background;
  }

  const banner = selectByType(images, "banner", ["original", "medium"]);
  if (banner) {
    return banner;
  }

  const image = show?.image && typeof show.image === "object" ? show.image : {};
  const poster = stringValue(image.original) || stringValue(image.medium);
  if (poster) {
    return {
      type: "poster",
      sourceUrl: poster,
      width: null,
      height: null,
      main: false,
      source: "tvmaze_show_image"
    };
  }

  return {
    type: "placeholder",
    sourceUrl: null,
    width: null,
    height: null,
    main: false,
    source: "placeholder"
  };
}
