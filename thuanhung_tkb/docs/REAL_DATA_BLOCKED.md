# REAL DATA BLOCKED BY MISSING TRANSFER PERMISSION

Verified with the original legacy loader and production dataset loader; no transfer permissions are injected. Raw legacy files remain unchanged.

40 active teachers; 7 branches; 113 classes; 5 active subjects; 479 assignments; 802 required periods.

Generation returns EMPTY / UNRESOLVABLE_ASSIGNMENT, with 0 candidates and 0 persisted schedules. No candidate exists, so a candidate hard-violation count is not applicable.

61 class-subject demands (76 periods) have eligible teachers, but none has the required destination-branch permission. The imported assignment decisions also contain 87 prohibited cross-branch assignments (142 periods); this count includes demands that can potentially be reassigned to a home teacher.

The confirmed workflow schedules teachers at their home branch first, then
considers transfer for remaining demand. The current run schedules 417
assignments / 722 periods locally with zero violations against the placed
subset. It leaves 62 assignments / 80 periods for transfer consideration.
The partial internal result is not returned as a timetable and cannot be saved;
the UI shows the progress and only displays a timetable when all demand is filled.

Of the remaining demand, 61 assignments / 76 periods have no eligible local
teacher and need explicit transfer permission. One additional English assignment
of 4 periods at Phân hiệu 3 remains after local scheduling: its sole local
English teacher faces 36 required periods and only 33 teaching slots. This is a
calendar limit, not an inferred legacy weekly capacity. Whole assignments remain
with one teacher, so the pending assignment has 4 periods rather than splitting
off the 3-period arithmetic deficit.

The API reports both local progress and all remaining transfer needs. Its
unresolvable diagnostic includes the 61 permission-blocked IDs and the additional
calendar-limited demand, without duplication across attempts.

| Destination / subject | Blocked demands | Required periods |
| --- | ---: | ---: |
| Phân hiệu 1 / Âm nhạc | 15 | 15 |
| Phân hiệu 3 / Giáo dục thể chất | 15 | 30 |
| Phân hiệu 2 / Tin học | 9 | 9 |
| Phân hiệu 3 / Tin học | 9 | 9 |
| Trường chính / Tin học | 13 | 13 |

## Demands blocked by permission

| Assignment ID | Class | Subject | Destination branch | Required periods | Eligible teachers, all denied |
| --- | --- | --- | --- | ---: | ---: |
| 6a95e5f9a4aafcb22d41b0c7 | 2A1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0c1 | 1B1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0be | 1A1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0c4 | 1C1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0ca | 2B1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0cd | 2C1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0d1 | 3A1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0d7 | 3B1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0dd | 3C1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0fb | 5B1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b14d | 1B3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b0e3 | 4A1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0ef | 4C1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b101 | 5C1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b14a | 1A3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b150 | 1C3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b0e9 | 4B1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b0f5 | 5A1 | Âm nhạc | Phân hiệu 1 | 1 | 6 |
| 6a95e5f9a4aafcb22d41b153 | 2A3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b163 | 3B3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b181 | 5A3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b18d | 5C3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b15d | 3A3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b175 | 4B3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b187 | 5B3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b156 | 2B3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b159 | 2C3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b169 | 3C3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a95e5f9a4aafcb22d41b17b | 4C3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a982da70fe941d5c19fffb5 | 3A2 | Tin học | Phân hiệu 2 | 1 | 4 |
| 6a982db50fe941d5c19fffd0 | 3B2 | Tin học | Phân hiệu 2 | 1 | 4 |
| 6a982dc30fe941d5c19fffeb | 3C2 | Tin học | Phân hiệu 2 | 1 | 4 |
| 6a982dd20fe941d5c1a00006 | 4A2 | Tin học | Phân hiệu 2 | 1 | 4 |
| 6a982ddf0fe941d5c1a00021 | 4B2 | Tin học | Phân hiệu 2 | 1 | 4 |
| 6a982df20fe941d5c1a0003c | 4C2 | Tin học | Phân hiệu 2 | 1 | 4 |
| 6a982e010fe941d5c1a00057 | 5A2 | Tin học | Phân hiệu 2 | 1 | 4 |
| 6a982e100fe941d5c1a00072 | 5B2 | Tin học | Phân hiệu 2 | 1 | 4 |
| 6a982e2d0fe941d5c1a0008f | 5C2 | Tin học | Phân hiệu 2 | 1 | 4 |
| 6a982e4b0fe941d5c1a000c0 | 3A3 | Tin học | Phân hiệu 3 | 1 | 4 |
| 6a982e570fe941d5c1a000db | 3B3 | Tin học | Phân hiệu 3 | 1 | 4 |
| 6a982e6e0fe941d5c1a000f6 | 3C3 | Tin học | Phân hiệu 3 | 1 | 4 |
| 6a982eb00fe941d5c1a00308 | 4A3 | Giáo dục thể chất | Phân hiệu 3 | 2 | 11 |
| 6a982eb70fe941d5c1a00316 | 4A3 | Tin học | Phân hiệu 3 | 1 | 4 |
| 6a982ec90fe941d5c1a0033d | 4B3 | Tin học | Phân hiệu 3 | 1 | 4 |
| 6a982ed50fe941d5c1a00358 | 4C3 | Tin học | Phân hiệu 3 | 1 | 4 |
| 6a982ee90fe941d5c1a00373 | 5A3 | Tin học | Phân hiệu 3 | 1 | 4 |
| 6a982ef80fe941d5c1a0038e | 5B3 | Tin học | Phân hiệu 3 | 1 | 4 |
| 6a982f4d0fe941d5c1a003a9 | 5C3 | Tin học | Phân hiệu 3 | 1 | 4 |
| 6a9830520fe941d5c1a0051f | 3A | Tin học | Trường chính | 1 | 4 |
| 6a98305d0fe941d5c1a0053a | 3B | Tin học | Trường chính | 1 | 4 |
| 6a9830690fe941d5c1a00555 | 3C | Tin học | Trường chính | 1 | 4 |
| 6a9830760fe941d5c1a00570 | 3D | Tin học | Trường chính | 1 | 4 |
| 6a9830800fe941d5c1a0058b | 4A | Tin học | Trường chính | 1 | 4 |
| 6a98308a0fe941d5c1a005a6 | 4B | Tin học | Trường chính | 1 | 4 |
| 6a9830970fe941d5c1a005c1 | 4C | Tin học | Trường chính | 1 | 4 |
| 6a9830a30fe941d5c1a005dc | 4D | Tin học | Trường chính | 1 | 4 |
| 6a9830b20fe941d5c1a005f7 | 5A | Tin học | Trường chính | 1 | 4 |
| 6a9830bd0fe941d5c1a00612 | 5B | Tin học | Trường chính | 1 | 4 |
| 6a9830c80fe941d5c1a0062d | 5C | Tin học | Trường chính | 1 | 4 |
| 6a9830d70fe941d5c1a00648 | 5D | Tin học | Trường chính | 1 | 4 |
| 6a9830ea0fe941d5c1a00663 | 5E | Tin học | Trường chính | 1 | 4 |

Detailed eligible teacher IDs, destination permission decisions, all 87 imported cross-branch assignments and historical workload metrics are recorded in `SCHEDULER_VERIFICATION.json`.

The positive HTTP E2E uses `EXPLICIT_TEST_TRANSFER_PERMISSION` in memory. Its success does not establish production data readiness.
