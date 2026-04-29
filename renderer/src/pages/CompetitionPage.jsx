export default function CompetitionPage({
  latestCompetition,
  latestCompetitionBusy,
  latestCompetitionError,
  refreshLatestCompetition,
  isCurrentCompetitionRow,
}) {
  return (
    <section className=" h-160 flex flex-col gap-6">
      <div className="competition__header grid gap-4 grid-cols-2 items-center">
        <div className="-mt-6">
          <h1 className="text-2xl font-normal competition__h leading-tight">
            Competition
            <span>
              {latestCompetition?.competitionNumber
                ? ` ${latestCompetition.competitionNumber}`
                : ""}
            </span>{" "}
            <div className="flex items-center gap-2 ">
              <button
                type="button"
                className="btn btn-clear btn-sm uppercase !tracking-wider font-light text-slate-300"
                onClick={() => void refreshLatestCompetition()}
                disabled={latestCompetitionBusy}
                title={
                  latestCompetition
                    ? "Refresh competition data"
                    : "Load competition data"
                }
              >
                {latestCompetitionBusy
                  ? latestCompetition
                    ? "Refreshing..."
                    : "Loading..."
                  : latestCompetition
                    ? "Refresh"
                    : "Load"}
              </button>
            </div>
          </h1>
        </div>
        <div className="gap-1 text-xs justify-self-end  flex flex-col flex-0">
          <div>
            Start{" "}
            {latestCompetition?.start ||
              latestCompetition?.datesText ||
              "Unknown"}
          </div>
          <div>
            End{" "}
            {latestCompetition?.end ||
              latestCompetition?.datesText ||
              "Unknown"}
          </div>
        </div>
      </div>

      <div className="card gap-4 competition__missions -mt-4">
        <div className="text-sm text-slate-400 hidden">Missions</div>
        {Array.isArray(latestCompetition?.missions) &&
        latestCompetition.missions.length ? (
          <ul className="text-sm list-disc pl-5 space-y-0.5 flex flex-wrap">
            {latestCompetition.missions.map((m, idx) => (
              <li className=" basis-1/2" key={`${idx}_${m}`}>
                {m}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-slate-300">No missions found.</div>
        )}
      </div>

      <div className="flex gap-4 h-101.5 overflow-x-visible overflow-y-hidden">
        <div className="gap-4 rounded-lg w-full h-full min-h-0 flex flex-col">
          {latestCompetitionError ? (
            <div className="text-sm text-red-300">{latestCompetitionError}</div>
          ) : null}

          {!latestCompetition ? (
            <div className="text-sm text-slate-300">
              {latestCompetitionBusy
                ? "Loading competition..."
                : "Press Load to fetch the latest competition."}
            </div>
          ) : (
            <div className="h-full min-h-0 flex flex-col gap-3">
              {latestCompetition.debug?.challenge ? (
                <div className="text-sm text-amber-200">
                  Headless scrape looks blocked (
                  {latestCompetition.debug.challenge}
                  ). Try again after opening the competitions page once in-app,
                  or disable bot protection.
                </div>
              ) : null}

              <div className="w-full flex-1 min-h-0 card flex flex-col">
                <div className="text-sm text-slate-400 w-full | hidden">
                  Results
                </div>
                {latestCompetition.resultsStatus ? (
                  <div className="text-sm text-slate-300">
                    {latestCompetition.resultsStatus}
                  </div>
                ) : Array.isArray(latestCompetition.userRows) &&
                  latestCompetition.userRows.length ? (
                  <div className=" overflow-hidden overflow-y-scroll w-full flex-1 min-h-0">
                    <table className="results-table w-full text-xs border-collapse h-full">
                      <thead className="">
                        <tr className="text-slate-400 border-b border-slate-700/70 ">
                          <th className="text-left font-normal py-1 pr-2">
                            Place
                          </th>
                          <th className="text-left   font-normal py-1 pr-2">
                            Player
                          </th>
                          <th className="text-right font-normal py-1 pr-2">
                            Completed
                          </th>
                          <th className="text-right font-normal py-1">
                            Unique NFTs
                          </th>
                        </tr>
                      </thead>
                      <tbody className="w-full">
                        {latestCompetition.userRows.map((row, idx) => {
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
                ) : Array.isArray(latestCompetition.users) &&
                  latestCompetition.users.length ? (
                  <ul className="text-sm list-disc pl-5 space-y-0.5">
                    {latestCompetition.users.map((u, idx) => (
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
          {Array.isArray(latestCompetition?.prizes) &&
          latestCompetition.prizes.length ? (
            <ul className="text-xs space-y-0.5 ">
              {latestCompetition.prizes.map((p, idx) => (
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
