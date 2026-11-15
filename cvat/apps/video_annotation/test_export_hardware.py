import unittest
from pathlib import Path
from unittest.mock import patch

from .export_hardware import cpu_budget, detect_hardware, render_budget, worker_count


class ExportHardwareTests(unittest.TestCase):
    def test_auto_scales_with_effective_cpu_capacity(self):
        with patch.dict('os.environ', {'CVAT_VIDEO_EXPORT_PROCESSES': 'auto'}):
            for cpus, expected in ((2, 2), (8, 6), (36, 24), (96, 64)):
                hardware = {'effective_cpus': cpus, 'available_memory_bytes': 128*1024**3}
                self.assertEqual(cpu_budget(hardware), expected)
            self.assertEqual(worker_count({'effective_cpus': 2, 'available_memory_bytes': 2*1024**3}), 1)
            self.assertEqual(worker_count({'effective_cpus': 36, 'available_memory_bytes': 64*1024**3}), 4)

    def test_resolution_and_memory_limit_process_count(self):
        hardware = {'effective_cpus': 36, 'available_memory_bytes': 8*1024**3}
        with patch.dict('os.environ', {'CVAT_VIDEO_EXPORT_PROCESSES': 'auto'}):
            self.assertEqual(render_budget(hardware, 984, 984), 24)
            self.assertEqual(render_budget(hardware, 7680, 4320), 1)
            hardware['available_memory_bytes'] = 256*1024**2
            self.assertEqual(render_budget(hardware, 1920, 1080), 1)

    def test_cgroup_v2_cpu_and_memory_limits_override_host_capacity(self):
        files = {'/sys/fs/cgroup/cpu.max': '250000 100000',
                 '/sys/fs/cgroup/memory.max': str(2*1024**3),
                 '/sys/fs/cgroup/memory.current': str(1536*1024**2),
                 '/proc/meminfo': 'MemTotal: 134217728 kB\nMemAvailable: 67108864 kB'}
        with patch('cvat.apps.video_annotation.export_hardware.read_text', side_effect=lambda p: files.get(str(p), '')), \
                patch('cvat.apps.video_annotation.export_hardware.hierarchy', return_value={Path('/sys/fs/cgroup')}), \
                patch('os.cpu_count', return_value=36), patch('os.sched_getaffinity', return_value=set(range(8))):
            hardware = detect_hardware()
        self.assertEqual(hardware['effective_cpus'], 2.5)
        self.assertEqual(hardware['available_memory_bytes'], 512*1024**2)
        self.assertEqual(hardware['memory_limit_bytes'], 2*1024**3)

    def test_cgroup_v1_and_manual_override_respect_quota(self):
        files = {'/sys/fs/cgroup/cpu.cfs_quota_us': '200000',
                 '/sys/fs/cgroup/cpu.cfs_period_us': '100000'}
        with patch('cvat.apps.video_annotation.export_hardware.read_text', side_effect=lambda p: files.get(str(p), '')), \
                patch('cvat.apps.video_annotation.export_hardware.hierarchy', return_value={Path('/sys/fs/cgroup')}), \
                patch('os.cpu_count', return_value=36), patch('os.sched_getaffinity', return_value=set(range(8))), \
                patch.dict('os.environ', {'CVAT_VIDEO_EXPORT_PROCESSES': '24'}):
            hardware = detect_hardware()
            self.assertEqual(cpu_budget(hardware), 2)
