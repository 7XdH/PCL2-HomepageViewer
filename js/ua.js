export const PCL_FALLBACK_UA = "PCL2/2.99.0.0";
export const DEFAULT_PROXY_UA = "PCL2-Homepage-Viewer";

export function getProxyUaCandidates(customUa = "") {
  const values = [];
  const custom = String(customUa ?? "").trim();
  values.push(custom);
  if (!values.includes(PCL_FALLBACK_UA)) values.push(PCL_FALLBACK_UA);
  return values;
}
