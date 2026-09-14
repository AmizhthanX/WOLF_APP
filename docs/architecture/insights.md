# GPU, process and storage intelligence

Two halves, deliberately split by where the data may live.

**On the PC**, the agent measures what it could not before: per-GPU load by engine family, video
memory and temperature; per-process CPU, GPU and GPU memory in the live process list; and each
volume's drive health and temperature.

**In the cloud**, insights are computed on request from telemetry already stored: when each volume
will fill, what a GPU's last day looked like, and the findings worth attention. Nothing is stored
that was not already there, and nothing about processes is — the cloud holds no process data.

## Pieces

| Piece | Where | Does |
| --- | --- | --- |
| Display-kernel interop | `windows/agent/Wolf.Agent.Core/Native/D3dkmt.cs` | Enumerate, query, close. Nothing else is bound |
| Adapter list | `Telemetry/GpuAdapters.cs` | Real GPUs: stable id, LUID, name, dedicated memory, temperature |
| GPU counters | `Telemetry/GpuCounters.cs` | Engine counters into per-adapter and per-process load (pure math + reader) |
| Drive health | `Telemetry/StorageHealthReader.cs` | Windows Storage Management health per volume, cached 5 min |
| Process CPU | `Commands/ProcessCpuSampler.cs` | CPU-time deltas into percentages, PID-reuse safe |
| Insights | `packages/telemetry-schema/src/insights.ts` | Pure: forecast, GPU summary, findings |
| API | `GET /api/v1/pcs/:pcId/insights` in `services/api/src/routes/telemetry.ts` | Joins latest sample and aggregates |
| Web | PC page: GPUs panel, Insights panel, drive temperature, process CPU/GPU columns | |

## GPUs

Adapters come from `D3DKMTEnumAdapters2` and `D3DKMTQueryAdapterInfo` — plain structs, no COM, no
device created on the GPU. Software renderers and adapters that cannot render (indirect display
drivers such as virtual monitors) are excluded; they have no load, memory or temperature.

- **Adapter id** is the PCI location (`pci-bus.device.function`), falling back to the LUID. The LUID
  changes every boot, and a series key that changed on restart would break history charts and alert
  rules narrowed to one GPU.
- **Load** is from the "GPU Engine" counters, with Task Manager's rules so the numbers agree: an
  engine is the sum of its processes (capped at 100%), an adapter is its busiest engine, a process
  is its busiest engine. Load is a rate, so the first reading after start is null, not zero.
- **Video memory used** is "GPU Adapter Memory / Dedicated Usage"; **total** is the display kernel's
  dedicated segment size.
- **Temperature** is the display kernel's adapter performance data (tenths of a degree; zero means
  no sensor and becomes null).
- **Not reported:** clock speeds, fan and power in watts. The display kernel gives power only as a
  share of the limit and fan in RPM, neither of which is what the schema's fields mean; vendor SDKs
  would be needed. They stay null.

## Processes

`process.list` now fills `cpuPercent`, `gpuPercent` and `gpuMemoryBytes`.

- CPU is the difference in CPU time between two readings over the wall time between them, as a
  share of the whole machine. A PID is matched on its start time too, so a reused PID is never
  differenced against the process that had it before.
- A list with no reading in the last 30 seconds takes one, waits 500 ms and takes another. A list
  within 30 seconds of the previous one measures since then and answers immediately.
- GPU percent is null for a process that started using the GPU since the last reading (no rate yet),
  zero for a process holding no GPU engine at all.
- Process data is returned to the caller on the command path and never stored.

## Drives

Health is Windows' own verdict (`MSFT_PhysicalDisk.HealthStatus`, or `MSFT_Disk` for a virtual
disk), mapped to `healthy`/`warning`/`failing`/`unknown`. Temperature is from
`MSFT_StorageReliabilityCounter`, which needs administrative rights: the agent service has them;
an ordinary test run does not and gets null. A volume spanning several drives reports the worst
health and the highest temperature. The privileged helper's `disk.smart-health` remains the
on-demand, attribute-level view.

## Insights

- **Storage forecast.** A least-squares line through up to 30 days of hourly `disk.usedPercent`,
  converted to bytes with the volume's current size. No forecast below 3 days or 24 points of
  history. A slope worth less than 0.5% of the volume over 30 days is "not growing". "Days until
  full" is measured from the current usage, and omitted past ten years. r² below 0.6 is reported as
  a poor fit — storage fills in steps, and the date is then rough.
- **GPU summary.** From 24 hours of five-minute buckets: sample-weighted average load, the busiest
  five-minute p95 (named as that, because the day's own p95 cannot be recovered from buckets),
  share of buckets averaging 80% or more, peak temperature, peak video memory and its share of the
  total. Load figures need at least an hour of buckets.
- **Findings,** most severe first: failing drive (critical), drive health warning, full within 7
  days (critical) or 30 days (warning), 90% full, drive at 70 °C or more, video memory peaking at
  95% or more, GPU at 87 °C or more, and — as information, not alarm — heavy GPU load for most of
  the day. Fixed templates over numbers; no finding can contain a process or file name.

The response carries `sampledAt`: insights about a PC silent for a week describe that week-old PC.

## Limits and unverified paths

- Drive temperatures from an elevated context have not been observed here; the tests run
  unelevated and assert the documented null.
- Adapter temperature relies on `KMTQAITYPE_ADAPTERPERFDATA`, available from Windows 10 2004
  drivers; older drivers return an error and the value is null.
- A volume resized within the forecast window distorts its slope.
