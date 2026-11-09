// Stamps the ByteBouncer icon and version info into the Windows executable
// without Wine (used when building the installer from Linux).
const fs = require('fs');
const path = require('path');
const resedit = require('resedit');
const pkg = require('../package.json');

const exe = process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked', 'ByteBouncer.exe');
const ico = path.join(__dirname, 'icon.ico');
const data = fs.readFileSync(exe);
const pe = resedit.NtExecutable.from(data, { ignoreCert: true });
const res = resedit.NtExecutableResource.from(pe);

// icon
const iconFile = resedit.Data.IconFile.from(fs.readFileSync(ico));
resedit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconFile.icons.map(i => i.data));

// version info
const vi = resedit.Resource.VersionInfo.createEmpty();
const [maj, min, pat] = pkg.version.split('.').map(Number);
vi.setFileVersion(maj, min, pat, 0, 1033);
vi.setProductVersion(maj, min, pat, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  CompanyName: 'ByteBouncer', FileDescription: 'ByteBouncer FTP client', FileVersion: pkg.version,
  InternalName: 'ByteBouncer', LegalCopyright: '© ByteBouncer', OriginalFilename: 'ByteBouncer.exe',
  ProductName: 'ByteBouncer', ProductVersion: pkg.version,
});
vi.outputToResourceEntries(res.entries);

res.outputResource(pe);
fs.writeFileSync(exe, Buffer.from(pe.generate()));
console.log('branded', exe);
