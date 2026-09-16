// Shared demo dataset used by every mock backend (JSON, XML, SOAP, SQLite)
// so the same customers are reachable through all four connector types.

export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  city: string;
  country: string;
  status: "ACTIVE" | "INACTIVE";
}

export const customers: Customer[] = [
  { id: "1", firstName: "Ada", lastName: "Lovelace", city: "London", country: "UK", status: "ACTIVE" },
  { id: "2", firstName: "Grace", lastName: "Hopper", city: "New York", country: "USA", status: "ACTIVE" },
  { id: "3", firstName: "Alan", lastName: "Turing", city: "Manchester", country: "UK", status: "INACTIVE" },
];

export function findCustomer(id: string): Customer | undefined {
  return customers.find((c) => c.id === id);
}
