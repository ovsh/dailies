export const aleMembershipList = [
  "Heading",
  "FIELD_DELIM\tTABS",
  "",
  "Column",
  "Name\tSource File Mob ID\tTracks",
  "Data",
  "Café Interview\t UMID-ALE-001 \tV",
  "B Roll\t\tV",
].join("\n");

export const edlMembershipList = [
  "TITLE: Membership",
  "FCM: NON-DROP FRAME",
  "",
  "001  AX       V     C        01:00:00:00 01:00:01:00 01:00:00:00 01:00:01:00",
  "* FROM CLIP NAME: Interview A",
  "002  BROLL02  V     C        01:00:00:00 01:00:01:00 01:00:01:00 01:00:02:00",
  "003  BL       V     C        01:00:00:00 01:00:01:00 01:00:02:00 01:00:03:00",
].join("\n");

export const csvMembershipList = [
  "\uFEFF\"Clip Name\",\"UMID\",\"Note\"",
  "\"Interview, Day 1\",\" UMID-CSV-001 \",\"He said \"\"go\"\"\"",
  "\"B Roll\",\"\",\"Exterior\"",
].join("\r\n");

export const oneColumnCsvMembershipList = [
  "Name",
  "Opening",
  "Closing",
].join("\n");

export const pastedMembershipList = [
  "  Opening Shot  ",
  "",
  "Closing Shot",
  "Opening Shot",
].join("\n");

export const malformedAleMembershipList = [
  "Column",
  "Tracks\tStart",
  "Data",
  "V\t01:00:00:00",
].join("\n");

export const malformedCsvMembershipList = [
  "Clip Name,UMID",
  "\"Unclosed,UMID-1",
].join("\n");

export const emptyEdlMembershipList = [
  "TITLE: Empty",
  "FCM: NON-DROP FRAME",
  "001  BL       V     C        01:00:00:00 01:00:01:00 01:00:00:00 01:00:01:00",
].join("\n");
