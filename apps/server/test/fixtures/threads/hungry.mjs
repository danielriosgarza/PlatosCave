// Allocates until the heap cap stops it (runInThread tests).
const hold = [];
for (let i = 0; ; i++) hold.push({ i, s: `item ${i}` });
