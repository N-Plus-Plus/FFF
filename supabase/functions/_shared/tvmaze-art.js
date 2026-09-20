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

// FFF's persistent show cards are deliberately panoramic. A 16:9 backdrop
// needs heavy side-cropping in that space, while TVmaze banners are commonly
// much closer. Keep this independent of a particular viewport: it describes
// the shared card-art asset, not an individual card's transient layout.
const CARD_ART_TARGET_RATIO = 5;

function aspectDistance(candidate) {
  if (!candidate?.width || !candidate?.height) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(Math.log((candidate.width / candidate.height) / CARD_ART_TARGET_RATIO));
}

function selectHorizontalArt(images) {
  const candidates = [
    ...((Array.isArray(images) ? images : [])
      .map((item) => candidateFromImage(item, "background", ["original"]))
      .filter(Boolean)),
    ...((Array.isArray(images) ? images : [])
      .map((item) => candidateFromImage(item, "banner", ["original", "medium"]))
      .filter(Boolean))
  ];
  if (!candidates.length) {
    return null;
  }
  return candidates.sort((left, right) => {
    const distance = aspectDistance(left) - aspectDistance(right);
    if (distance) return distance;
    if (left.main !== right.main) return left.main ? -1 : 1;
    return right.width * right.height - left.width * left.height;
  })[0];
}

export function selectTvmazeCardArt(show, images) {
  const horizontal = selectHorizontalArt(images);
  if (horizontal) {
    return horizontal;
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
