export default function CompetitionPage({
  latestCompetition,
  latestCompetitionList,
  selectedCompetitionNumber,
  setSelectedCompetitionNumber,
  latestCompetitionBusy,
  latestCompetitionError,
  refreshLatestCompetition,
  isCurrentCompetitionRow,
}) {
  const competitions = Array.isArray(latestCompetitionList)
    ? latestCompetitionList
    : latestCompetition
      ? [latestCompetition]
      : [];
  const selectedCompetition =
    competitions.find(
      (competition) =>
        String(
          competition?.competitionNumber || competition?.scrapedAt || "",
        ) === String(selectedCompetitionNumber || ""),
    ) ||
    competitions[0] ||
    latestCompetition;

  return (
    <section className=" h-160 flex flex-col gap-3">
      <div className="competition__header grid gap-4 grid-cols-2 items-center">
        <div className="-mt-6">
          <h1 className="text-2xl font-normal competition__h leading-tight">
            Competition
            <span>
              {selectedCompetition?.competitionNumber
                ? ` ${selectedCompetition.competitionNumber}`
                : ""}
            </span>{" "}
          </h1>
          {competitions.length > 1 ? (
            <select
              className="select select-sm  bg-black/50 focus-within:bg-black border-white/10 text-slate-100 w-auto"
              value={String(selectedCompetitionNumber || "")}
              onChange={(event) =>
                setSelectedCompetitionNumber?.(event.target.value)
              }
              disabled={latestCompetitionBusy}
            >
              {competitions.map((competition, index) => {
                const value = String(
                  competition?.competitionNumber ||
                    competition?.scrapedAt ||
                    index,
                );
                const label = competition?.competitionNumber
                  ? `Competition ${competition.competitionNumber}`
                  : `Competition ${index + 1}`;
                return (
                  <option key={value} value={value}>
                    {label}
                  </option>
                );
              })}
            </select>
          ) : null}
        </div>
        <div className="gap-1 text-xs justify-self-end  flex flex-col flex-0 relative">
          <button
            type="button"
            className="btn btn-xs btn-black z-10 rounded-sm font-normal px-2 inline-flex absolute -top-7 right-0"
            onClick={() => void refreshLatestCompetition()}
            disabled={latestCompetitionBusy}
            title={
              latestCompetition
                ? "Refresh competition data"
                : "Load competition data"
            }
          >
            {latestCompetitionBusy
              ? selectedCompetition
                ? "Refreshing..."
                : "Loading..."
              : selectedCompetition
                ? "Refresh Results"
                : "Load"}
          </button>
          <div>
            Start{" "}
            {selectedCompetition?.start ||
              selectedCompetition?.datesText ||
              "Unknown"}
          </div>
          <div>
            End{" "}
            {selectedCompetition?.end ||
              selectedCompetition?.datesText ||
              "Unknown"}
          </div>
        </div>
      </div>

      <div className="card gap-4 competition__missions">
        <div className="text-sm text-slate-400 hidden">Missions</div>
        {Array.isArray(selectedCompetition?.missions) &&
        selectedCompetition.missions.length ? (
          <ul className="text-sm list-disc pl-5 space-y-0.5 flex flex-wrap">
            {selectedCompetition.missions.map((m, idx) => (
              <li className=" basis-1/2" key={`${idx}_${m}`}>
                {m}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-slate-300">No missions found.</div>
        )}
      </div>

      <div className="flex gap-4 h-108 overflow-x-visible overflow-y-hidden">
        <div className="gap-4 rounded-lg w-full h-full min-h-0 flex flex-col">
          {latestCompetitionError ? (
            <div className="text-sm text-red-300">{latestCompetitionError}</div>
          ) : null}

          {!selectedCompetition ? (
            <div className="text-sm text-slate-300">
              {latestCompetitionBusy
                ? "Loading competition..."
                : "Press Load to fetch the latest competition."}
            </div>
          ) : (
            <div className="h-full min-h-0 flex flex-col gap-3">
              {selectedCompetition.debug?.challenge ? (
                <div className="text-sm text-amber-200">
                  Headless scrape looks blocked (
                  {selectedCompetition.debug.challenge}
                  ). Try again after opening the competitions page once in-app,
                  or disable bot protection.
                </div>
              ) : null}

              <div className="w-full flex-1 min-h-0 card flex flex-col">
                <div className="text-sm text-slate-400 w-full | hidden">
                  Results
                </div>
                {selectedCompetition.resultsStatus ? (
                  <div className="text-sm text-slate-300">
                    {selectedCompetition.resultsStatus}
                  </div>
                ) : Array.isArray(selectedCompetition.userRows) &&
                  selectedCompetition.userRows.length ? (
                  <div className=" overflow-hidden overflow-y-scroll w-full flex-1 min-h-0">
                    <table className="results-table w-full text-xs border-collapse h-full ">
                      <thead className="sticky top-1">
                        <tr className="text-slate-400 border-b border-slate-700/70  p-0">
                          <th className="text-left font-normal py-1 !pt-0 pr-2">
                            Place
                          </th>
                          <th className="text-left   font-normal py-1 !pt-0 pr-2">
                            Player
                          </th>
                          <th className="text-right font-normal py-1 !pt-0 pr-2">
                            Completed
                          </th>
                          <th className="text-right font-normal py-1 !pt-0 ">
                            Unique
                          </th>
                        </tr>
                      </thead>
                      <tbody className="w-full">
                        {selectedCompetition.userRows.map((row, idx) => {
                          const isCurrentUserRow = isCurrentCompetitionRow(
                            row.player,
                          );
                          return (
                            <tr
                              key={`${idx}_${row.player}_${row.rank}`}
                              className={`border-b border-slate-800/70 last:border-0 gap-2 ${
                                isCurrentUserRow ? "results-row--current" : ""
                              }`}
                            >
                              <td className="py-1 pr-2 rounded-l-md text-slate-200">
                                {Number.isFinite(Number(row.rank))
                                  ? Number(row.rank)
                                  : "-"}
                              </td>
                              <td className="py-1 pr-2 text-slate-100">
                                {row.player || "-"}
                              </td>
                              <td className="py-1 pr-2 text-right text-slate-200">
                                {Number.isFinite(Number(row.completed))
                                  ? Number(row.completed)
                                  : "-"}
                              </td>
                              <td className="py-1 text-right text-slate-200 rounded-r-md">
                                {Number.isFinite(Number(row.uniqueNFTs))
                                  ? Number(row.uniqueNFTs)
                                  : "-"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : Array.isArray(selectedCompetition.users) &&
                  selectedCompetition.users.length ? (
                  <ul className="text-sm list-disc pl-5 space-y-0.5">
                    {selectedCompetition.users.map((u, idx) => (
                      <li key={`${idx}_${u}`}>{u}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-sm text-slate-300">No users found.</div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="space-y-1 max-w-50 w-full">
          <div className="text-sm text-slate-400 mish-gradient !text-2xl">
            Prizes
          </div>
          {Array.isArray(selectedCompetition?.prizes) &&
          selectedCompetition.prizes.length ? (
            <ul className="text-xs space-y-0.5 ">
              {selectedCompetition.prizes.map((p, idx) => (
                <li key={`${idx}_${p}`} className="flex flex-col gap-2">
                  {p}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-slate-300">No prizes found.</div>
          )}
        </div>
      </div>
    </section>
  );
}
