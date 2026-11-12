// Narrow compatibility patch for the exported Unity 6000.3.28f1 loader.
// Refuse unfamiliar generated code instead of silently publishing an unpatched player.
const marker = '/* ProbablyStolen data loader v1 */';
export function patchUnityLoader(source) {
  if (!/\bfunction createUnityInstance\(/.test(source)) {
    // A real Unity loader in an unfamiliar shape must not ship without the data-download fix.
    if (/UnityWebData1\.0|fetchWithProgress|unityFramework/.test(source))
      throw new Error('Unsupported Unity loader: createUnityInstance signature changed');
    return source;
  }
  const changes = [
    ['e=g.fetchWithProgress,s=g[r]', 'e=g.fetchDataWithProgress||g.fetchWithProgress,s=g[r]'],
    ['.catch(function(e){var r="Failed to download file "+s;"file:"==location.protocol?d(r+". Loading web pages via a file:// URL without a web server is not supported by this browser. Please use a local development web server to host Unity content, or use the Unity Build and Run option.","error"):console.error(r)})',
     '.catch(function(e){g.startupErrorHandler(new Error("Không tải được dữ liệu game "+s+": "+(e&&e.message||e)));return null})'],
    ['o.then(function(r){var e=new TextDecoder("utf-8"),t=0;', 'o.then(function(r){if(!r)return;var e=new TextDecoder("utf-8"),t=0;'],
  ];
  if (source.includes(marker)) {
    if (changes.some(([, after]) => source.split(after).length !== 2))
      throw new Error('Unsupported Unity loader: incomplete previous data-download patch');
    return source;
  }
  for (const [before, after] of changes) {
    if (source.split(before).length !== 2) throw new Error('Unsupported Unity loader: data-download patch anchor changed');
    source = source.replace(before, after);
  }
  return source + '\n' + marker + '\n';
}
