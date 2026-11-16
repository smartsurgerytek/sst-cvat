"""CPU/container/memory-aware export limits. No Django or heavy imports needed."""
import json
import math
import os
from pathlib import Path

MIB = 1024 * 1024


def read_text(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


def hierarchy(controller):
    """Inspect the current cgroup and its parents, including inherited quotas."""
    bases = [Path('/sys/fs/cgroup')]
    if controller == 'cpu':
        bases += [Path('/sys/fs/cgroup/cpu'), Path('/sys/fs/cgroup/cpu,cpuacct')]
    else:
        bases += [Path('/sys/fs/cgroup/memory')]
    groups = []
    for line in read_text('/proc/self/cgroup').splitlines():
        fields = line.split(':', 2)
        if len(fields) == 3 and (not fields[1] or controller in fields[1].split(',')):
            groups.append(fields[2].lstrip('/'))
    result = set(bases)
    for base in bases:
        for group in groups:
            path = base / group
            if path.is_dir():
                while path != base and base in path.parents:
                    result.add(path)
                    path = path.parent
    return result


def detect_hardware():
    logical = os.cpu_count() or 1
    affinity = len(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else logical
    effective = float(affinity)
    for path in hierarchy('cpu'):
        values = read_text(path / 'cpu.max').split()
        if len(values) == 2 and values[0].isdigit() and values[1].isdigit() and int(values[1]):
            effective = min(effective, int(values[0]) / int(values[1]))
        quota = read_text(path / 'cpu.cfs_quota_us')
        period = read_text(path / 'cpu.cfs_period_us')
        if quota.isdigit() and period.isdigit() and int(period):
            effective = min(effective, int(quota) / int(period))
    memory = {}
    for line in read_text('/proc/meminfo').splitlines():
        key, _, value = line.partition(':')
        if value.strip().split() and value.strip().split()[0].isdigit():
            memory[key] = int(value.strip().split()[0]) * 1024
    available = memory.get('MemAvailable', memory.get('MemFree', 512 * MIB))
    limit = memory.get('MemTotal', available)
    for path in hierarchy('memory'):
        for limit_name, usage_name in (('memory.max', 'memory.current'),
                                       ('memory.limit_in_bytes', 'memory.usage_in_bytes')):
            cap, used = read_text(path / limit_name), read_text(path / usage_name)
            if cap.isdigit() and int(cap) < 2**60:
                limit = min(limit, int(cap))
                available = min(available, max(0, int(cap) - (int(used) if used.isdigit() else 0)))
    physical = set()
    for processor in range(logical):
        if hasattr(os, 'sched_getaffinity') and processor not in os.sched_getaffinity(0):
            continue
        root = Path(f'/sys/devices/system/cpu/cpu{processor}/topology')
        package, core = read_text(root / 'physical_package_id'), read_text(root / 'core_id')
        if package and core:
            physical.add((package, core))
    model = next((line.split(':', 1)[1].strip() for line in read_text('/proc/cpuinfo').splitlines()
                  if line.startswith('model name')), 'unknown')
    return {'model': model, 'logical_cpus': logical, 'affinity_cpus': affinity,
            'physical_cores': len(physical) or None, 'effective_cpus': max(.1, effective),
            'memory_limit_bytes': limit, 'available_memory_bytes': available}


def cpu_budget(hardware=None):
    hardware = hardware or detect_hardware()
    setting = os.environ.get('CVAT_VIDEO_EXPORT_PROCESSES', 'auto')
    # Each rendering process also owns decoder/encoder threads. The measured saturation
    # point is about 2 rendering processes per 3 available logical CPUs.
    requested = math.ceil(hardware['effective_cpus'] * 2 / 3) if setting == 'auto' else int(setting)
    return max(1, min(math.ceil(hardware['effective_cpus']), requested))


def render_budget(hardware, width=1920, height=1080):
    # Includes source images, A+B canvases, one prefetched frame and codec buffers.
    estimated_bytes = 128 * MIB + width * height * 96
    memory_slots = int(hardware['available_memory_bytes'] * .7 / estimated_bytes)
    return max(1, min(cpu_budget(hardware), memory_slots))


def worker_count(hardware=None):
    hardware = hardware or detect_hardware()
    cpu_workers = max(1, math.floor(hardware['effective_cpus'] / 6))
    memory_workers = max(1, hardware['available_memory_bytes'] // (1024 * MIB))
    return min(4, cpu_workers, memory_workers)


if __name__ == '__main__':
    import sys
    hardware = detect_hardware()
    if '--workers' in sys.argv:
        print(worker_count(hardware))
    else:
        print(json.dumps({**hardware, 'render_process_budget': cpu_budget(hardware),
                          'export_workers': worker_count(hardware)}))
