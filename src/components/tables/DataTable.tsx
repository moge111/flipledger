'use client';

import {useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowUpDown, ArrowUp, ArrowDown, Search, ChevronLeft, ChevronRight } from 'lucide-react';

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, any>[];
  searchPlaceholder?: string;
  pageSize?: number;
  footerRow?: Record<string, React.ReactNode>;
}

export default function DataTable<T>({ data, columns, searchPlaceholder = 'Search...', pageSize = 50, footerRow }: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    // Match against every field on row.original (not just declared columns).
    // This lets APIs attach extra context like orderId / customerOrderId to
    // each row and have it be searchable without adding columns.
    globalFilterFn: (row, _columnId, filterValue) => {
      const search = String(filterValue).toLowerCase().trim();
      if (!search) return true;
      const original = row.original as Record<string, unknown>;
      for (const v of Object.values(original)) {
        if (v == null) continue;
        if (Array.isArray(v)) {
          if (v.some(x => x != null && String(x).toLowerCase().includes(search))) return true;
        } else if (String(v).toLowerCase().includes(search)) {
          return true;
        }
      }
      return false;
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const pageCount = table.getPageCount();
  const currentPage = table.getState().pagination.pageIndex;
  const totalRows = table.getFilteredRowModel().rows.length;
  const startRow = currentPage * pageSize + 1;
  const endRow = Math.min((currentPage + 1) * pageSize, totalRows);

  return (
    <div className="panel overflow-hidden">
      {/* Search Bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            type="text"
            value={globalFilter}
            onChange={e => setGlobalFilter(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full h-9 pl-8 pr-3 bg-bg-input border border-border-strong rounded-md text-[13.5px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            {table.getHeaderGroups().map(headerGroup => (
              <tr key={headerGroup.id} className="bg-bg-surface">
                {headerGroup.headers.map(header => (
                  <th
                    key={header.id}
                    onClick={header.column.getCanSort() ? header.column.getToggleSortingHandler() : undefined}
                    className={`px-3 py-2.5 text-left text-[11px] label-caps text-text-tertiary ${
                      header.column.getCanSort() ? 'cursor-pointer select-none hover:text-text-primary' : ''
                    }`}
                    style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getCanSort() && (
                        <span className="text-text-tertiary">
                          {header.column.getIsSorted() === 'asc' ? (
                            <ArrowUp size={12} className="text-text-primary" />
                          ) : header.column.getIsSorted() === 'desc' ? (
                            <ArrowDown size={12} className="text-text-primary" />
                          ) : (
                            <ArrowUpDown size={12} />
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map(row => (
              <tr key={row.id} className="border-b border-border-subtle hover:bg-bg-hover transition-colors">
                {row.getVisibleCells().map(cell => (
                  <td key={cell.id} className="px-3 py-2.5 text-sm">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footerRow && (
            <tfoot>
              <tr className="bg-bg-surface border-t-[1.5px] border-border-strong sticky bottom-0">
                {table.getHeaderGroups()[0].headers.map(header => (
                  <td key={header.id} className="px-3 py-2.5 text-sm font-bold tabular-nums">
                    {footerRow[header.id] || ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t-[1.5px] border-border-strong">
          <span className="text-sm text-text-tertiary tabular-nums">
            {startRow}–{endRow} of {totalRows.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="p-1 rounded-md border-[1.5px] border-border-strong bg-bg-surface hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={16} className="text-text-primary" />
            </button>
            <span className="text-sm text-text-secondary px-2 tabular-nums">
              {currentPage + 1} / {pageCount}
            </span>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="p-1 rounded-md border-[1.5px] border-border-strong bg-bg-surface hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={16} className="text-text-primary" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
