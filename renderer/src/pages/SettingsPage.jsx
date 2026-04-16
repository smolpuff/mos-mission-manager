import ToggleSwitch from "../components/ToggleSwitch/app";

import pbpIcon from "../img/icon_pbp.webp";
import solIcon from "../img/icon-sm__sol.svg";
import ccIcon from "../img/icon_cc.webp";
import tcIcon from "../img/icon_tc.webp";

export default function SettingsPage() {
  return (
    <section>
      <div className="grid grid-cols-2 gap-2">
        <div className="card h-full flex items-center justify-center">
          <div className="flex gap-2 flex-col">
            <ToggleSwitch
              switchID="enableResets"
              title="Enable Mission Level Reset"
            />
            <ToggleSwitch switchID="enableRentals" title="Enable Rentals" />
          </div>
        </div>

        <div className="card grid grid-cols-2 gap-x-2 gap-y-1 items-center">
          <div className="flex gap-2 items-center user__wallet-balance-item">
            <img
              src={solIcon}
              alt="Solana Logo"
              className="w-8 h-8 aspect-square"
            />
            <div className="flex flex-col gap-0 w-full">
              <span className="user__wallet-ballance-sol_increase text-success text-sm leading-tight">
                (+0.002)
              </span>
              <span className="user__wallet-ballance-sol text-lg font-semibold leading-tight">
                0.2
              </span>
            </div>
          </div>
          <div className="flex gap-2 items-center user__wallet-balance-item">
            <img
              src={pbpIcon}
              alt="PBP Token Logo"
              className="w-8 h-8 aspect-square"
            />
            <div className="flex flex-col gap-0">
              <span className="user__wallet-ballance-so_increase text-success text-sm leading-tight">
                (+1500)
              </span>
              <span className="user__wallet-ballance-sol text-lg font-semibold leading-tight">
                169,420.43
              </span>
            </div>
          </div>
          <div className="flex gap-2 items-center user__wallet-balance-item">
            <img
              src={ccIcon}
              alt="Community Coins Logo"
              className="w-8 h-8 aspect-square"
            />
            <div className="flex flex-col gap-0">
              <span className="user__wallet-ballance-so_increase text-success text-sm leading-tight">
                (0.002)
              </span>
              <span className="user__wallet-ballance-sol text-lg font-semibold leading-tight">
                0.2
              </span>
            </div>
          </div>
          <div className="flex gap-2 items-center user__wallet-balance-item">
            <img
              src={tcIcon}
              alt="Tournament Coins Logo"
              className="w-8 h-8 aspect-square"
            />
            <div className="flex flex-col gap-0">
              <span className="user__wallet-ballance-so_increase text-success text-sm leading-tight">
                (0.002)
              </span>
              <span className="user__wallet-ballance-sol text-lg font-semibold leading-tight">
                0.2
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
