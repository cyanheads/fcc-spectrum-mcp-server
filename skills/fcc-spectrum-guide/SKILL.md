---
name: fcc-spectrum-guide
description: Investigate FCC ULS licenses, nearby sites, spectrum holdings, leases, and microwave paths with fcc_spectrum_* tools. Use when combining results or deciding whether an empty search, market match, or filed site supports a geographic or technical conclusion.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Investigate filed radio authorizations and their relationships. These records do not establish actual transmissions, identify an observed signal, predict RF coverage, or determine whether a channel is clear to use. Full-power broadcast stations and satellite earth stations are outside this ULS index.

## Identifiers

- Keep the USI returned by license, frequency, or nearby-site searches for subsequent detail reads. Callsigns can identify several records; select a returned USI when the particular record matters.
- Follow FRNs returned on license records to investigate the same registered licensee without relying on name spelling. Some filings lack an FRN.
- Take market codes from returned license or spectrum-block records, or use a code supplied by the user. A city name can describe markets of several types; these tools have no market-name resolver. Do not infer a market code from the city name.
- Keep the license USI alongside location and antenna numbers. A location number can refer to several sites; it is not a globally unique site identifier.
- A lease's licensee is the lessee. Follow its leasedFrom links for parent licenses and a parent's leases for leasing arrangements, using the returned callsign or USI.

## Gates

- Before reporting an authorization absent, check coverage with fcc_spectrum_list_reference: confirm the relevant service group is indexed, inspect freshness and notices, and finish the search's pages. A ready index is searchable; it does not certify that every filed technical value is represented.
- Continue while nextCursor exists, even after an empty frequency-search page. When totalIsLowerBound is true, report totalCount as at least that many, not an exact total.
- Before treating an empty technical list as evidence, check technicalRetained and coverage notices. Older generations can lack microwave paths or unnumbered antennas until rebuilt. Only active, pending-legal, and term-pending records retain technical detail.
- Before attributing a frequency to a particular site, check whether the location number is shared. ULS does not identify which of those sites uses each antenna or frequency; leave that attribution unresolved.
- Before reporting transmitters near a point, inspect filed location class and type. Nearby results can include receivers, passive sites, and operating-area centers. An area's center falling outside the search radius does not establish that its operating area cannot reach the point. Locations without valid coordinates are excluded entirely.
- Before making a county- or point-specific market claim, stop at the available geography: market state matching establishes only that the market reaches that state. Nationwide and Gulf markets do not match a state; some Tribal and MVDDS markets also lack a usable state match. Investigate a known market code without a state filter to reach those records.
- Do not infer a PAL's assigned frequency from its channel width. List Priority Access Licenses through fcc_spectrum_search_licenses using service PL, then read their details; frequency search excludes these unassigned channels.

## Workflows

For a carrier's holdings in a place, separate registered-owner discovery from authorization geography. Name-search the carrier, inspect the returned entities and FRNs, then investigate its site assignments and market blocks. A license search's state is the mailing address; it does not locate the carrier's sites or markets. Name search can exclude redacted individuals and some organizations classified as individuals, so use a known callsign, USI, or FRN when name search misses a known record.

For a nearby-site investigation, carry each result's USI and location number into fcc_spectrum_get_license. Compare the nearby frequency count with the frequencies shown before treating that list as complete. Read the detail notice for omitted frequency rows, follow location and lease continuation offsets independently, and preserve the selected USI throughout.

For a microwave link, read the transmitting antenna's filed paths. The receive location and antenna resolve within that same license. Look up a receiving callsign separately when the receiving station's license is needed; it is not the source of the displayed receive coordinates. Keep missing or shared endpoints unresolved.

For an unfamiliar station class, decode the filed code through fcc_spectrum_list_reference. Preserve an unknown code as filed and describe the authorization category without treating it as evidence of on-air activity.
