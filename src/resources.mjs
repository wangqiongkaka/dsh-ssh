export const resourceCommand = `set -eu
export LC_ALL=C
printf 'DSH_HOST_RESOURCES_V1\\n'
os=$(uname -s)
printf 'os %s\\n' "$os"
printf 'hostname '; hostname
if [ "$os" != Linux ] || [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then
  printf 'unsupported 1\\n'
  exit 0
fi
awk '/^cpu[0-9]+ / {n++} END {print "cores " n}' /proc/stat
before=$(awk '/^cpu / {for(i=2;i<=9;i++) total+=$i; printf "%.0f %.0f\\n", total, $5+$6; exit}' /proc/stat)
sleep 1
awk -v before="$before" 'BEGIN {split(before,b," ")} /^cpu / {for(i=2;i<=9;i++) total+=$i; delta=total-b[1]; if(delta>0) printf "cpu %.1f\\n", 100*(1-($5+$6-b[2])/delta); else print "cpu -1"; exit}' /proc/stat
awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {available=$2; found=1} /^MemFree:/ {free=$2} /^Buffers:/ {buffers=$2} /^Cached:/ {cached=$2} /^SReclaimable:/ {reclaim=$2} /^Shmem:/ {shared=$2} END {if(!found) available=free+buffers+cached+reclaim-shared; printf "memory %.0f %.0f\\n", total*1024, available*1024}' /proc/meminfo
df -Pk / | awk 'NR==2 {printf "disk %.0f %.0f %.0f\\n", $2*1024, $3*1024, $4*1024}'
awk '{printf "uptime %.0f\\n", $1}' /proc/uptime`;

export function parseResources(output) {
  const marker = 'DSH_HOST_RESOURCES_V1\n', start = output.indexOf(marker);
  if (start < 0) throw new Error('主机资源响应无效');
  const fields = new Map(output.slice(start + marker.length).trim().split('\n').map(line => {
    const space = line.indexOf(' '); return [line.slice(0, space), line.slice(space + 1).trim()];
  }));
  const os = fields.get('os'), hostname = fields.get('hostname');
  if (!os || !hostname || os.length > 80 || hostname.length > 256) throw new Error('主机信息响应无效');
  if (fields.get('unsupported') === '1') return { os, hostname, unsupported: true };
  const numbers = (field, count) => {
    const value = fields.get(field)?.split(/\s+/).map(Number);
    if (!value || value.length !== count || value.some(number => !Number.isFinite(number) || number < 0)) throw new Error('主机资源响应不完整');
    return value;
  };
  const [cores] = numbers('cores', 1), [totalBytes, availableBytes] = numbers('memory', 2);
  const [diskTotal, diskUsed, diskAvailable] = numbers('disk', 3), [uptimeSeconds] = numbers('uptime', 1);
  const cpuPercent = fields.get('cpu') === '-1' ? null : numbers('cpu', 1)[0];
  if (!Number.isInteger(cores) || cores < 1 || totalBytes <= 0 || availableBytes > totalBytes || diskTotal <= 0 || diskUsed > diskTotal || diskAvailable > diskTotal || cpuPercent > 100) throw new Error('主机资源数值无效');
  return { os, hostname, cores, cpuPercent, uptimeSeconds,
    memory: { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes },
    disk: { totalBytes: diskTotal, usedBytes: diskUsed, availableBytes: diskAvailable } };
}
